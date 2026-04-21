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

// To get per-kind contributions when a line has multiple chunks, we build:
//   1. prefix = API messages for lines[0..i-1]
//   2. prefix+target = prefix ++ lineToApiMessage(lines[i])
//   3. For each kind in chunks: prefix ++ synthetic-single-kind-msg
// The deltas give us isolated per-kind contributions. Single-chunk lines skip
// step 3 (the delta from 1→2 is already clean).
export function planRequestsForTarget(
  sessionHash: string,
  prefixMsgs: AnthropicMessage[],
  target: SampleTarget,
): PreviewRequest[] {
  const targetMsg = lineToApiMessage(target.parsed);
  if (!targetMsg) return [];
  const plan: PreviewRequest[] = [];
  // prefix (needed for subtraction)
  plan.push({
    sessionHash,
    lineIdx: target.lineIdx,
    purpose: "prefix",
    messages: prefixMsgs,
  });
  // prefix+target (needed to attribute total contribution of this line)
  plan.push({
    sessionHash,
    lineIdx: target.lineIdx,
    purpose: "prefix+target",
    messages: [...prefixMsgs, targetMsg],
  });
  // Per-kind isolation for multi-chunk lines. For single-chunk lines the
  // target delta already captures the whole (and only) chunk's contribution,
  // so we don't need per-kind sub-calls.
  if (target.chunks.length > 1) {
    for (const chunk of target.chunks) {
      plan.push({
        sessionHash,
        lineIdx: target.lineIdx,
        purpose: "prefix+synthetic-kind",
        kind: chunk.kind,
        messages: [...prefixMsgs, syntheticMessageForChunk(chunk)],
      });
    }
  }
  return plan;
}

// A minimal standalone message that carries a single chunk's content in a
// shape the API accepts. Role choice aligns with how the real content would
// appear: tool_use/tool_result go inside user/assistant turns structurally,
// but for isolation we wrap them in a synthetic role-appropriate message.
function syntheticMessageForChunk(chunk: BillableChunk): AnthropicMessage {
  switch (chunk.kind) {
    case "user_text":
    case "system_text":
    case "tool_result_string":
      return { role: "user", content: chunk.text };
    case "assistant_text":
      return { role: "assistant", content: [{ type: "text", text: chunk.text }] };
    case "tool_use_input": {
      let input: unknown;
      try {
        input = JSON.parse(chunk.text);
      } catch {
        input = { raw: chunk.text };
      }
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "synthetic",
            name: "Synthetic",
            input,
          },
        ],
      };
    }
    case "tool_result_array": {
      let content: unknown[];
      try {
        content = JSON.parse(chunk.text) as unknown[];
        if (!Array.isArray(content)) content = [{ type: "text", text: chunk.text }];
      } catch {
        content = [{ type: "text", text: chunk.text }];
      }
      return {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "synthetic", content },
        ],
      };
    }
    case "thinking_text":
    case "thinking_signature":
      // API rejects assistant messages whose final block is `thinking`. Pad
      // with a minimal text block; its ~2-token cost is absorbed into the
      // regression intercept during fitting.
      return {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: chunk.kind === "thinking_text" ? chunk.text : "",
            signature: chunk.kind === "thinking_signature" ? chunk.text : "",
          },
          { type: "text", text: "." },
        ],
      };
  }
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

// Translate all visible lines up to (but not including) idx into a compact
// AnthropicMessage[] prefix. Preserves turn ordering expected by the API.
// The final API-validity pass happens in ensureApiValid, not here.
export function buildPrefix(lines: string[], upToLineIdx: number): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (let i = 0; i < upToLineIdx; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue;
    }
    const m = lineToApiMessage(parsed);
    if (m) out.push(m);
  }
  return out;
}

// Enforces the count_tokens API's message-structure invariants on any
// messages array just before the call. Two rules:
//   1. An assistant message's final block cannot be `thinking`. We strip
//      trailing thinking blocks; if nothing non-thinking remains, we drop
//      the message.
//   2. `tool_use` blocks must have a matching `tool_result` in the next
//      message. When the final assistant message has unpaired tool_uses
//      (the conversation was cut mid-turn), we append a synthetic user
//      message with empty tool_result blocks closing each id. The few-token
//      overhead is absorbed into the regression intercept during fitting.
// Returns a new array; inputs are not mutated.
export function ensureApiValid(msgs: AnthropicMessage[]): AnthropicMessage[] {
  const result = [...msgs];
  if (result.length === 0) return result;
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
      const prefix = buildPrefix(lines, target.lineIdx);
      const plans = planRequestsForTarget(sessionHash, prefix, target);
      allPlans.push(...plans);
      totalRequests += plans.length;

      if (flags.dryRun) continue;

      // Execute the plan: sequential calls, rate-limited.
      // count_tokens rejects empty messages arrays, so skip plans that reduce
      // to an empty list after validation; counts.get("prefix") falls through
      // to 0, which is the correct value when prefix is empty.
      const counts = new Map<string, number>(); // purpose|kind? -> tokens
      const executable = plans
        .map((p) => ({ plan: p, messages: ensureApiValid(p.messages) }))
        .filter((x) => x.messages.length > 0);
      for (const { plan: p, messages } of executable) {
        if (apiCallBudget > 0 && apiCallsMade >= apiCallBudget) {
          budgetExhausted = true;
          break;
        }
        await limiter.waitTurn();
        const tokens = await anthropicCountTokens({
          model: flags.model,
          messages,
        });
        apiCallsMade++;
        counts.set(p.kind ? `${p.purpose}|${p.kind}` : p.purpose, tokens);
        process.stdout.write(
          `[calibrate]  call ${apiCallsMade}${apiCallBudget ? `/${apiCallBudget}` : ""} line ${target.lineIdx} ${p.purpose}${p.kind ? `/${p.kind}` : ""} → ${tokens}\n`,
        );
      }
      if (budgetExhausted) break;

      const prefixTokens = counts.get("prefix") ?? 0;
      const withTargetTokens = counts.get("prefix+target") ?? 0;
      const lineTotalContribution = withTargetTokens - prefixTokens;

      if (target.chunks.length === 1) {
        const chunk = target.chunks[0];
        const key = `${sessionHash}|${target.lineIdx}|${chunk.kind}`;
        if (existingKeys.has(key)) continue;
        const rec: CalibrationRecord = {
          sessionHash,
          lineIdx: target.lineIdx,
          kind: chunk.kind,
          textLength: chunk.text.length,
          rawEstimate: countRawBase(chunk.text, chunk.kind),
          anthropicTruth: lineTotalContribution,
          timestamp: new Date().toISOString(),
          model: flags.model,
        };
        allRecords.push(rec);
        await appendFile(flags.out, JSON.stringify(rec) + "\n", "utf-8");
        existingKeys.add(key);
      } else {
        // Multi-chunk: use per-kind synthetic deltas against the same prefix.
        for (const chunk of target.chunks) {
          const key = `${sessionHash}|${target.lineIdx}|${chunk.kind}`;
          if (existingKeys.has(key)) continue;
          const synth = counts.get(`prefix+synthetic-kind|${chunk.kind}`);
          if (synth === undefined) continue;
          const contribution = synth - prefixTokens;
          const rec: CalibrationRecord = {
            sessionHash,
            lineIdx: target.lineIdx,
            kind: chunk.kind,
            textLength: chunk.text.length,
            rawEstimate: countRawBase(chunk.text, chunk.kind),
            anthropicTruth: Math.max(0, contribution),
            timestamp: new Date().toISOString(),
            model: flags.model,
          };
          allRecords.push(rec);
          await appendFile(flags.out, JSON.stringify(rec) + "\n", "utf-8");
          existingKeys.add(key);
        }
      }
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
