// Tokenizer calibration harness.
//
// Reads one or more Claude Code JSONL session files, samples messages across
// the session's timeline, and calls Anthropic's /v1/messages/count_tokens for
// each sample to learn per-content-kind correction factors for the local
// tiktoken-based estimator. The count_tokens endpoint is FREE (no billing) but
// rate-limited; at tier 1 the ceiling is 100 RPM.
//
// Output: one JSON record per line to calibration/<date>.jsonl with fields
//   { sessionHash, lineIdx, kind, textLength, rawEstimate, anthropicTruth,
//     timestamp, model }
// The analyzer (scripts/analyze-calibration.ts) reads these records, fits a
// per-kind linear model, and emits tokenizer-corrections.json.
//
// Usage:
//   tsx scripts/calibrate-tokens.ts <session1.jsonl> [session2.jsonl ...] [flags]
//     --rpm N       Requests per minute (default 80)
//     --out PATH    Output JSONL (default calibration/<ISO-date>.jsonl)
//     --resume      Skip (sessionHash, lineIdx, kind) tuples already present
//     --model MODEL count_tokens model (default claude-opus-4-7)
//     --dry-run     Don't call API; write would-be requests to OUT.preview.jsonl
//
// Exit codes:
//   0  success
//   1  CLI/IO error
//   2  API error (after retries)

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  extractBillableChunks,
  isVisibleMessage,
} from "../src/main/sessions/claude/adapter";
import { countRawBase } from "../src/main/sessions/tokenizer";
import type { ClaudeLine, ClaudeContentBlock } from "../src/main/sessions/claude/types";
import type { BillableChunk, ContentKind } from "../src/shared/types";
import {
  countTokens as anthropicCountTokens,
  type AnthropicMessage,
  type AnthropicContentBlock,
} from "../src/main/llm/anthropic-count";

// --- Types ---

interface CliFlags {
  sessions: string[];
  rpm: number;
  out: string;
  resume: boolean;
  model: string;
  dryRun: boolean;
  maxRequests: number; // hard cap on API calls (0 = unlimited)
}

export interface CalibrationRecord {
  sessionHash: string; // sha1 prefix of the session file path
  lineIdx: number; // physical line index in the JSONL
  kind: ContentKind;
  textLength: number; // length of the chunk's text
  // Pre-calibration raw estimate (chars / kind-specific divisor). The
  // analyzer fits truth = a*rawEstimate + b; at runtime we apply a,b to
  // countRawBase to produce a calibrated count.
  rawEstimate: number;
  anthropicTruth: number;
  timestamp: string;
  model: string;
}

interface PreviewRequest {
  sessionHash: string;
  lineIdx: number;
  purpose: "prefix" | "prefix+target" | "prefix+synthetic-kind";
  kind?: ContentKind; // only for synthetic-kind
  messages: AnthropicMessage[];
}

// --- CLI parsing ---

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    sessions: [],
    rpm: 80,
    out: path.join(
      "calibration",
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    ),
    resume: false,
    model: "claude-opus-4-7",
    dryRun: false,
    maxRequests: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpm") flags.rpm = Number(argv[++i]);
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--resume") flags.resume = true;
    else if (a === "--model") flags.model = argv[++i];
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--max-requests") flags.maxRequests = Number(argv[++i]);
    else if (!a.startsWith("--")) flags.sessions.push(a);
    else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  if (flags.sessions.length === 0) {
    process.stderr.write(
      "usage: tsx scripts/calibrate-tokens.ts <session.jsonl> [...] [--flags]\n",
    );
    process.exit(1);
  }
  return flags;
}

// --- JSONL → API message translation ---

// Maps a parsed line to an AnthropicMessage, preserving exactly the content
// blocks the API will bill for when the session is re-sent. Lines that don't
// map to a chat turn (attachments, snapshots, etc.) return null — they're not
// part of the message history.
export function lineToApiMessage(line: ClaudeLine): AnthropicMessage | null {
  if (!isVisibleMessage(line)) return null;
  const msg = line.message;
  if (!msg) return null;
  const role = line.type === "assistant" ? "assistant" : "user";
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }
  if (!Array.isArray(msg.content)) return null;
  const blocks: AnthropicContentBlock[] = [];
  for (const block of msg.content) {
    const translated = translateBlock(block);
    if (translated) blocks.push(translated);
  }
  // API contract: an assistant message's final block cannot be `thinking`.
  // In real runs the next block is usually a tool_use or text; some JSONL
  // lines store a bare-thinking variant that's not a valid standalone API
  // turn. Match the API's own rewrite-on-resend behavior by stripping
  // trailing thinking blocks here.
  if (role === "assistant") {
    while (
      blocks.length > 0 &&
      blocks[blocks.length - 1].type === "thinking"
    ) {
      blocks.pop();
    }
  }
  if (blocks.length === 0) return null;
  return { role, content: blocks };
}

function translateBlock(block: ClaudeContentBlock): AnthropicContentBlock | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking") {
    const signature = (block as { signature?: unknown }).signature;
    return {
      type: "thinking",
      thinking: typeof block.thinking === "string" ? block.thinking : "",
      signature: typeof signature === "string" ? signature : "",
    };
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    const id = (block as { id?: unknown }).id;
    return {
      type: "tool_use",
      id: typeof id === "string" ? id : "tool_call_unknown",
      name: block.name,
      input: block.input ?? {},
    };
  }
  if (block.type === "tool_result") {
    const rb = block as {
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };
    return {
      type: "tool_result",
      tool_use_id: typeof rb.tool_use_id === "string" ? rb.tool_use_id : "",
      content:
        typeof rb.content === "string"
          ? rb.content
          : Array.isArray(rb.content)
            ? (rb.content as unknown[])
            : "",
      is_error: typeof rb.is_error === "boolean" ? rb.is_error : false,
    };
  }
  // image / document / anything else: skip — not in this calibration's scope.
  return null;
}

// --- Target collection ---

interface SampleTarget {
  lineIdx: number; // physical JSONL line index
  parsed: ClaudeLine;
  chunks: BillableChunk[];
}

// Every visible line with at least one billable chunk is a calibration target.
// No sampling — the analyzer wants as much data as the API budget permits, and
// `--resume` lets long runs be interrupted and continued.
export function collectTargets(lines: string[]): SampleTarget[] {
  const targets: SampleTarget[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue;
    }
    if (!isVisibleMessage(parsed)) continue;
    const chunks = extractBillableChunks(parsed);
    if (chunks.length === 0) continue;
    targets.push({ lineIdx: i, parsed, chunks });
  }
  return targets;
}

// --- Request plan for one target ---

// One request per line: count_tokens({messages: [just this line]}). The API
// returns the cost of that single message in isolation, which is exactly the
// truth we need to calibrate against the line's rawEstimate. No prefix, no
// subtraction, no synthetic messages. Multi-chunk lines produce one record
// per chunk, all sharing the same anthropicTruth (the whole-line total);
// the analyzer's multivariate fit attributes the total across kinds.
export function planRequestsForTarget(
  sessionHash: string,
  target: SampleTarget,
): PreviewRequest[] {
  const targetMsg = lineToApiMessage(target.parsed);
  if (!targetMsg) return [];
  return [
    {
      sessionHash,
      lineIdx: target.lineIdx,
      purpose: "prefix+target",
      messages: [targetMsg],
    },
  ];
}

// --- Rate limiter ---

// Simple elapsed-time gate — not a token bucket, because count_tokens is
// stateless/idempotent and we never need bursts. Spacing is minRequestGapMs =
// 60_000 / rpm. Preserves budget safety even if upstream is slow.
export class RateLimiter {
  private minGapMs: number;
  private lastAt = 0;
  constructor(rpm: number, private now: () => number = Date.now) {
    this.minGapMs = 60_000 / rpm;
  }
  async waitTurn(): Promise<void> {
    const n = this.now();
    const elapsed = n - this.lastAt;
    if (elapsed < this.minGapMs) {
      await new Promise((r) => setTimeout(r, this.minGapMs - elapsed));
    }
    this.lastAt = this.now();
  }
}

// --- Main orchestration ---

function sessionHashOf(filePath: string): string {
  return crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 12);
}

async function loadExistingKeys(outPath: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const raw = await readFile(outPath, "utf-8");
    for (const ln of raw.split("\n")) {
      if (!ln.trim()) continue;
      try {
        const rec = JSON.parse(ln) as CalibrationRecord;
        set.add(`${rec.sessionHash}|${rec.lineIdx}|${rec.kind}`);
      } catch {
        continue;
      }
    }
  } catch {
    // file doesn't exist yet — empty set is correct
  }
  return set;
}

// Enforces the count_tokens API's message-structure invariants on any
// messages array just before the call. Three rules:
//   1. An assistant message's final block cannot be `thinking`. Strip trailing
//      thinking; if nothing non-thinking remains, drop the message.
//   2. `tool_use` blocks must have a matching `tool_result` in the next message.
//      Close unpaired trailing tool_uses with a synthetic user tool_result.
//   3. `tool_result` blocks must have a matching `tool_use` in the *previous*
//      message. Open unpaired leading tool_results by prepending a synthetic
//      assistant tool_use with the same id.
// The synthetic wrappers add a fixed few-token overhead that falls into the
// regression intercept. Returns a new array; inputs are not mutated.
export function ensureApiValid(msgs: AnthropicMessage[]): AnthropicMessage[] {
  const result = [...msgs];
  if (result.length === 0) return result;

  // Rule 3: prepend synthetic tool_use when the first message is a user with
  // orphan tool_result(s). Do this first so the closure pass below sees a
  // complete head→tail structure.
  const first = result[0];
  if (first.role === "user" && Array.isArray(first.content)) {
    const leadingToolResultIds: string[] = [];
    for (const b of first.content) {
      if (b.type === "tool_result") {
        leadingToolResultIds.push((b as { tool_use_id: string }).tool_use_id);
      }
    }
    if (leadingToolResultIds.length > 0) {
      result.unshift({
        role: "assistant",
        content: leadingToolResultIds.map((id) => ({
          type: "tool_use",
          id,
          name: "synthetic",
          input: {},
        })),
      });
    }
  }

  // Rules 1 & 2: trailing thinking / unpaired trailing tool_use.
  const last = result[result.length - 1];
  if (last.role !== "assistant" || typeof last.content === "string") {
    return result;
  }
  const blocks = [...last.content];
  while (blocks.length > 0 && blocks[blocks.length - 1].type === "thinking") {
    blocks.pop();
  }
  if (blocks.length === 0) {
    result.pop();
    return result;
  }
  if (blocks.length !== last.content.length) {
    result[result.length - 1] = { role: "assistant", content: blocks };
  }
  const toolUseIds: string[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use") {
      toolUseIds.push((b as { id: string }).id);
    }
  }
  if (toolUseIds.length > 0) {
    result.push({
      role: "user",
      content: toolUseIds.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "",
      })),
    });
  }
  return result;
}

async function writePreview(plans: PreviewRequest[], outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const body = plans.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await writeFile(outPath, body, "utf-8");
}

async function runCalibration(flags: CliFlags): Promise<void> {
  await mkdir(path.dirname(flags.out), { recursive: true });
  const existingKeys = flags.resume ? await loadExistingKeys(flags.out) : new Set<string>();
  const limiter = new RateLimiter(flags.rpm);
  const allPlans: PreviewRequest[] = [];
  const allRecords: CalibrationRecord[] = [];
  let totalRequests = 0;
  let apiCallsMade = 0;
  const apiCallBudget = flags.maxRequests; // 0 = unlimited
  let budgetExhausted = false;

  for (const sessionPath of flags.sessions) {
    const sessionHash = sessionHashOf(sessionPath);
    process.stdout.write(`[calibrate] loading ${sessionPath} (hash ${sessionHash})\n`);
    const content = await readFile(sessionPath, "utf-8");
    const lines = content.split("\n");
    const targets = collectTargets(lines);
    process.stdout.write(
      `[calibrate]  ${targets.length} billable lines from ${lines.length} total\n`,
    );

    for (const target of targets) {
      if (budgetExhausted) break;

      // Only single-chunk lines yield clean per-kind records. Multi-chunk
      // lines mix kinds in one API response and would require multivariate
      // attribution — skip them. The common kinds all have plenty of
      // single-chunk representation.
      if (target.chunks.length !== 1) continue;

      const plans = planRequestsForTarget(sessionHash, target);
      allPlans.push(...plans);
      totalRequests += plans.length;

      if (flags.dryRun) continue;

      const executable = plans
        .map((p) => ({ plan: p, messages: ensureApiValid(p.messages) }))
        .filter((x) => x.messages.length > 0);
      if (executable.length === 0) continue;

      const chunk = target.chunks[0];
      const key = `${sessionHash}|${target.lineIdx}|${chunk.kind}`;
      if (existingKeys.has(key)) continue;

      if (apiCallBudget > 0 && apiCallsMade >= apiCallBudget) {
        budgetExhausted = true;
        break;
      }
      await limiter.waitTurn();
      const truth = await anthropicCountTokens({
        model: flags.model,
        messages: executable[0].messages,
      });
      apiCallsMade++;
      process.stdout.write(
        `[calibrate]  call ${apiCallsMade}${apiCallBudget ? `/${apiCallBudget}` : ""} line ${target.lineIdx} ${chunk.kind} → ${truth}\n`,
      );

      const rec: CalibrationRecord = {
        sessionHash,
        lineIdx: target.lineIdx,
        kind: chunk.kind,
        textLength: chunk.text.length,
        rawEstimate: countRawBase(chunk.text, chunk.kind),
        anthropicTruth: truth,
        timestamp: new Date().toISOString(),
        model: flags.model,
      };
      allRecords.push(rec);
      await appendFile(flags.out, JSON.stringify(rec) + "\n", "utf-8");
      existingKeys.add(key);
    }
  }

  if (flags.dryRun) {
    const previewPath = flags.out + ".preview.jsonl";
    await writePreview(allPlans, previewPath);
    process.stdout.write(
      `[calibrate] DRY RUN — ${totalRequests} requests planned, wrote ${previewPath}\n`,
    );
    return;
  }

  const budgetNote = budgetExhausted
    ? ` (stopped at --max-requests=${apiCallBudget})`
    : "";
  process.stdout.write(
    `[calibrate] done — wrote ${allRecords.length} records in ${apiCallsMade} API calls to ${flags.out}${budgetNote}\n`,
  );
}

// --- Entrypoint ---

if (process.argv[1] && process.argv[1].endsWith("calibrate-tokens.ts")) {
  const flags = parseArgs(process.argv.slice(2));
  runCalibration(flags).catch((err) => {
    process.stderr.write(`[calibrate] error: ${(err as Error).message}\n`);
    process.exit(2);
  });
}
