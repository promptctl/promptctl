// Token reconciliation validator
//
// Reads a Claude Code session JSONL and compares our tiktoken-based per-message
// estimates against the API's ground-truth `usage` values embedded in every
// assistant turn. The Anthropic API reports the *actual* number of tokens the
// server billed for at each turn, so any divergence between "sum of our
// estimates for all billable lines up to this turn" and "API-reported
// input+cache_creation+cache_read at this turn" is our math being wrong (modulo
// the constant system-prompt + tool-definition offset that is client-generated
// and never appears in the JSONL).
//
// Usage:
//   tsx scripts/validate-tokens.ts <path-to-session.jsonl> [--json] [--every N]
//
// Exit codes:
//   0  no anomalies (within-segment drift under threshold)
//   1  CLI/IO error
//   3  within-segment drift exceeds threshold — tokenizer or extractor is wrong
//      (compaction-induced jumps between segments are NOT a failure; they're
//      a session-level reality the validator filters out via segmentation)

import { readFile } from "node:fs/promises";
import {
  extractBillableChunks,
  isVisibleMessage,
} from "../src/main/sessions/claude/adapter";
import { sumChunks } from "../src/main/sessions/tokenizer";
import type { ClaudeLine } from "../src/main/sessions/claude/types";

interface TurnRecord {
  turnIndex: number; // index among assistant turns
  physIdx: number; // physical line number in the JSONL
  apiInput: number; // input_tokens
  apiCacheCreation: number; // cache_creation_input_tokens
  apiCacheRead: number; // cache_read_input_tokens
  apiTotalInput: number; // sum of the three (context size the API actually saw)
  apiOutput: number; // output_tokens
  ourSumBefore: number; // sum of our estimates for all billable lines STRICTLY before this one
  delta: number; // apiTotalInput - ourSumBefore
  segmentIndex: number; // bumped each time we detect a context compaction
}

interface SegmentStats {
  segmentIndex: number;
  turnCount: number;
  firstTurn: number; // turnIndex of first turn in segment
  lastTurn: number; // turnIndex of last turn in segment
  minDelta: number;
  maxDelta: number;
  medianDelta: number;
  // Drift is max - min across the segment. A healthy tokenizer produces near-constant
  // delta within a segment (the system-prompt + tool-def baseline is fixed); drift
  // over a few thousand tokens means we're missing or over-counting content.
  driftWithinSegment: number;
}

interface ValidationReport {
  filePath: string;
  totalLines: number;
  visibleLines: number;
  assistantTurnsWithUsage: number;
  turns: TurnRecord[];
  // Compaction events split the session into segments. Within a segment, the
  // delta = api - our_sum should be near-constant (the system+tools baseline).
  // Across segments it's discontinuous because the API no longer re-sends the
  // pre-compaction content while our sum keeps accumulating all file lines.
  segments: SegmentStats[];
  worstSegmentDrift: number; // max drift across all segments — the key health metric
}

function parseArgs(argv: string[]): {
  filePath: string;
  json: boolean;
  every: number;
} {
  const json = argv.includes("--json");
  const everyIdx = argv.indexOf("--every");
  const every = everyIdx >= 0 ? Number(argv[everyIdx + 1]) : 1;
  const positional = argv.filter((a, i) => {
    if (a === "--json") return false;
    if (a === "--every") return false;
    if (argv[i - 1] === "--every") return false;
    return !a.startsWith("--");
  });
  const filePath = positional[0];
  if (!filePath) {
    process.stderr.write(
      "usage: tsx scripts/validate-tokens.ts <session.jsonl> [--json] [--every N]\n",
    );
    process.exit(1);
  }
  return { filePath, json, every: Number.isFinite(every) && every > 0 ? every : 1 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Compaction detector: a segment boundary fires when apiTotalInput drops by
// more than 50% relative to the running max within the current segment. Each
// segment starts a fresh accumulator so intra-segment drift is measured
// independently of what happened before the reset.
function isCompactionBoundary(
  prevMax: number,
  currentApiTotal: number,
): boolean {
  if (prevMax < 10_000) return false; // too early to tell; need a meaningful baseline
  return currentApiTotal < prevMax * 0.5;
}

export async function validate(filePath: string): Promise<ValidationReport> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const turns: TurnRecord[] = [];
  let visibleLines = 0;
  let ourSumAbsolute = 0; // absolute sum across the whole file
  let ourSumSegment = 0; // sum since last compaction boundary
  let turnIndex = 0;
  let segmentIndex = 0;
  let segmentApiMax = 0;

  for (let physIdx = 0; physIdx < lines.length; physIdx++) {
    const raw = lines[physIdx];
    if (!raw.trim()) continue;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue;
    }
    if (!isVisibleMessage(parsed)) continue;
    visibleLines++;

    const usage = parsed.type === "assistant" ? parsed.message?.usage : undefined;
    if (usage) {
      const apiInput = usage.input_tokens ?? 0;
      const apiCacheCreation = usage.cache_creation_input_tokens ?? 0;
      const apiCacheRead = usage.cache_read_input_tokens ?? 0;
      const apiTotalInput = apiInput + apiCacheCreation + apiCacheRead;

      if (isCompactionBoundary(segmentApiMax, apiTotalInput)) {
        segmentIndex++;
        ourSumSegment = 0;
        segmentApiMax = 0;
      }
      if (apiTotalInput > segmentApiMax) segmentApiMax = apiTotalInput;

      turns.push({
        turnIndex: turnIndex++,
        physIdx,
        apiInput,
        apiCacheCreation,
        apiCacheRead,
        apiTotalInput,
        apiOutput: usage.output_tokens ?? 0,
        ourSumBefore: ourSumSegment,
        delta: apiTotalInput - ourSumSegment,
        segmentIndex,
      });
    }

    const billable = sumChunks(extractBillableChunks(parsed));
    ourSumAbsolute += billable;
    ourSumSegment += billable;
  }

  const segments: SegmentStats[] = [];
  const bySegment = new Map<number, TurnRecord[]>();
  for (const t of turns) {
    if (!bySegment.has(t.segmentIndex)) bySegment.set(t.segmentIndex, []);
    bySegment.get(t.segmentIndex)!.push(t);
  }
  for (const [segIdx, segTurns] of bySegment) {
    const deltas = segTurns.map((t) => t.delta);
    const min = Math.min(...deltas);
    const max = Math.max(...deltas);
    segments.push({
      segmentIndex: segIdx,
      turnCount: segTurns.length,
      firstTurn: segTurns[0].turnIndex,
      lastTurn: segTurns[segTurns.length - 1].turnIndex,
      minDelta: min,
      maxDelta: max,
      medianDelta: median(deltas),
      driftWithinSegment: max - min,
    });
  }
  segments.sort((a, b) => a.segmentIndex - b.segmentIndex);

  const worstSegmentDrift = segments.length
    ? Math.max(...segments.map((s) => s.driftWithinSegment))
    : 0;

  void ourSumAbsolute; // kept for future whole-file diagnostics

  return {
    filePath,
    totalLines: lines.length,
    visibleLines,
    assistantTurnsWithUsage: turns.length,
    turns,
    segments,
    worstSegmentDrift,
  };
}

function formatPlain(report: ValidationReport, every: number): string {
  const lines: string[] = [];
  lines.push(`File:        ${report.filePath}`);
  lines.push(`Total lines: ${report.totalLines}`);
  lines.push(
    `Visible:     ${report.visibleLines}    Assistant turns w/ usage: ${report.assistantTurnsWithUsage}`,
  );
  lines.push(`Segments:    ${report.segments.length} (compaction events split them)`);
  lines.push("");
  lines.push(
    "seg  turn  physIdx  apiInput  cacheCreation   cacheRead  apiTotal  ourSum(seg)    delta",
  );
  lines.push(
    "---  ----  -------  --------  -------------  ----------  --------  -----------  -------",
  );
  for (const t of report.turns) {
    if (t.turnIndex % every !== 0 && t.turnIndex !== report.turns.length - 1) {
      continue;
    }
    lines.push(
      [
        String(t.segmentIndex).padStart(3),
        String(t.turnIndex).padStart(4),
        String(t.physIdx).padStart(7),
        String(t.apiInput).padStart(8),
        String(t.apiCacheCreation).padStart(13),
        String(t.apiCacheRead).padStart(10),
        String(t.apiTotalInput).padStart(8),
        String(t.ourSumBefore).padStart(11),
        (t.delta >= 0 ? "+" : "") + String(t.delta),
      ].join("  "),
    );
  }
  lines.push("");
  lines.push("Per-segment drift (apiTotalInput - ourSumBefore should stay near-constant within a segment):");
  for (const s of report.segments) {
    lines.push(
      `  seg ${s.segmentIndex}: turns ${s.firstTurn}–${s.lastTurn} (${s.turnCount}) ` +
        `min=${s.minDelta} median=${s.medianDelta} max=${s.maxDelta} drift=${s.driftWithinSegment}`,
    );
  }
  lines.push(`  worst drift across segments: ${report.worstSegmentDrift}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const { filePath, json, every } = parseArgs(process.argv.slice(2));
  let report: ValidationReport;
  try {
    report = await validate(filePath);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatPlain(report, every));
  }

  // Drift > 30k tokens within a single segment means the per-turn baseline
  // (system prompt + tool defs) is moving, which means we're missing (or double-
  // counting) content. A healthy session should stay within ~10k of its starting
  // baseline across a segment. The threshold is intentionally loose because
  // tiktoken ≠ Claude's tokenizer; we want to catch structural bugs, not noise.
  if (report.worstSegmentDrift > 30_000) process.exit(3);
  process.exit(0);
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("validate-tokens.ts")) {
  main();
}
