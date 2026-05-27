// [LAW:one-source-of-truth] Pure projection over a chain of RequestRecords
// using the same systemPromptHash / toolsHash / contentHash primitives the
// PromptsPanel and ConversationTab already consume. Two views asking "did
// the system prompt change between R3 and R4?" must answer the same way;
// that is true by construction when they use the same hash function.
//
// [LAW:single-enforcer] All chain-level prompt/tools evolution logic lives
// here: bucketing into contiguous version-runs, diffing between consecutive
// distinct runs, structural diff of tools by name. The ChainDiffTab is a
// pure renderer over these outputs.
//
// [LAW:dataflow-not-control-flow] One scan, one shape out. A chain of
// length 1, length N, with null-system requests, with mixed providers —
// every shape flows through the same scan. Variability lives in the
// resulting ChainVersionRun list, not in branches that select different
// code paths.
//
// [LAW:types-are-the-program] A ChainVersionRun is non-empty by
// construction (it always contains at least one request). The hash field
// is `string | null` — `null` is a real version state ("no system prompt
// on this stretch of the chain"), lifted into the type so the UI never
// has to ask "is this a real version" with a separate flag.
//
// Why runs and not buckets: AABA must produce three runs (A, B, A) so the
// user sees that the system prompt flickered back to its earlier form.
// bucketBySystemPrompt would collapse it to two buckets — useful for the
// "what distinct prompts have I ever seen" view, wrong for "how did THIS
// chain evolve."

import { diffLines, type Change } from "diff";
import type { RequestRecord } from "../../../shared/proxy-events";
import { contentHash } from "./conversation";
import { fullPromptText } from "./promptBuckets";
import {
  extractSystem,
  extractTools,
  systemPromptHash,
  toolsHash,
} from "./promptHash";

// ─── Version runs ─────────────────────────────────────────────────────────

export interface ChainVersionRun {
  // FNV-1a-64 hex hash of the value, or null when the value itself is
  // absent on every request in this run. The type carries the "absent"
  // signal — no parallel `isPresent` flag.
  readonly hash: string | null;
  // The value as it appeared on the first request in the run. For system
  // prompts this is the raw `system` field (string or array of blocks);
  // for tools this is the raw `tools` array; null when absent on this run.
  // `extractSystem` and `extractTools` from ac1.6.5 normalize absence to
  // null by construction (never undefined) — the strict `=== null` checks
  // in the renderer are correct because of that contract.
  readonly value: unknown;
  // Every request id whose hash matched this run (in chain order).
  // length >= 1 by construction.
  readonly requestIds: readonly string[];
  // The first request in the run — the one that introduced this version
  // (relative to the previous run, or the chain root).
  readonly firstIntroducedAt: string;
}

// Scan the chain in causal order; whenever the hash changes from the
// previous request, start a new run.
//
// `hashOf` extracts and hashes the value; `valueOf` extracts the raw
// value for display purposes (so the UI can render the actual prompt
// text or tools array, not just the hash).
function scanRuns(
  chain: readonly RequestRecord[],
  hashOf: (record: RequestRecord) => string | null,
  valueOf: (record: RequestRecord) => unknown,
): ChainVersionRun[] {
  interface RunBuilder {
    hash: string | null;
    value: unknown;
    requestIds: string[];
    firstIntroducedAt: string;
  }
  const runs: ChainVersionRun[] = [];
  let current: RunBuilder | null = null;

  for (const record of chain) {
    const hash = hashOf(record);
    if (current === null || hash !== current.hash) {
      if (current !== null) runs.push(current);
      current = {
        hash,
        value: valueOf(record),
        requestIds: [record.requestId],
        firstIntroducedAt: record.requestId,
      };
      continue;
    }
    current.requestIds.push(record.requestId);
  }
  if (current !== null) runs.push(current);
  return runs;
}

export function buildSystemRuns(
  chain: readonly RequestRecord[],
): ChainVersionRun[] {
  return scanRuns(
    chain,
    (r) => systemPromptHash(r.requestBody),
    (r) => extractSystem(r.requestBody),
  );
}

export function buildToolsRuns(
  chain: readonly RequestRecord[],
): ChainVersionRun[] {
  return scanRuns(
    chain,
    (r) => toolsHash(r.requestBody),
    (r) => extractTools(r.requestBody),
  );
}

// ─── System diff ──────────────────────────────────────────────────────────

export interface SystemDiffChunk {
  readonly kind: "added" | "removed" | "unchanged";
  readonly value: string;
}

// Textual line-by-line diff of system prompts. Null sides are treated as
// the empty string — the result reads naturally as "the whole new prompt
// was added" when going from absent → present, or "the whole prompt was
// removed" the other way.
//
// `value` carries the full chunk text including the trailing newline that
// `diff` emits per line; the renderer uses that as-is so wrapping and
// blank lines look like the source.
export function diffSystem(from: unknown, to: unknown): SystemDiffChunk[] {
  const fromText = from === null ? "" : fullPromptText(from);
  const toText = to === null ? "" : fullPromptText(to);
  const changes: Change[] = diffLines(fromText, toText);
  return changes.map((change) => ({
    kind: change.added ? "added" : change.removed ? "removed" : "unchanged",
    value: change.value,
  }));
}

// ─── Tools diff ───────────────────────────────────────────────────────────

export interface ToolsDiff {
  readonly added: readonly ToolDescriptor[];
  readonly removed: readonly ToolDescriptor[];
  readonly changed: readonly ChangedTool[];
}

export interface ToolDescriptor {
  // The tool's `name` field. Two tools with the same name across consecutive
  // requests are considered the same tool — Anthropic's wire format uses
  // name as the natural identifier. Tools without a parseable name fall
  // into "(unnamed)" and may end up reported as both added and removed if
  // the unnamed tools change; that's acceptable noise for a malformed
  // payload.
  readonly name: string;
  readonly value: unknown;
}

export interface ChangedTool {
  readonly name: string;
  readonly from: unknown;
  readonly to: unknown;
}

// Structural diff by tool name. A tool is "changed" when both sides
// contain a tool with the same name but a different contentHash.
//
// Null sides: a null `from` makes every tool in `to` an addition; a null
// `to` makes every tool in `from` a removal. Both null → no changes.
export function diffTools(from: unknown, to: unknown): ToolsDiff {
  const fromTools = asToolList(from);
  const toTools = asToolList(to);
  const fromByName = indexByName(fromTools);
  const toByName = indexByName(toTools);

  const added: ToolDescriptor[] = [];
  const removed: ToolDescriptor[] = [];
  const changed: ChangedTool[] = [];

  for (const [name, value] of toByName) {
    const prior = fromByName.get(name);
    if (prior === undefined) {
      added.push({ name, value });
      continue;
    }
    if (contentHash(prior) !== contentHash(value)) {
      changed.push({ name, from: prior, to: value });
    }
  }
  for (const [name, value] of fromByName) {
    if (!toByName.has(name)) removed.push({ name, value });
  }

  return { added, removed, changed };
}

function asToolList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function indexByName(tools: readonly unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const tool of tools) {
    out.set(toolNameOf(tool), tool);
  }
  return out;
}

function toolNameOf(tool: unknown): string {
  if (
    tool !== null &&
    typeof tool === "object" &&
    typeof (tool as { name?: unknown }).name === "string"
  ) {
    return (tool as { name: string }).name;
  }
  return "(unnamed)";
}
