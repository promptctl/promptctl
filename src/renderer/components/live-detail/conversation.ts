// [LAW:one-source-of-truth] Deduped-conversation projection of a chain of
// RequestRecords. Inputs are records; output is a derived TimelineEntry[].
// No parallel store; the projection re-runs when the chain shape changes.
//
// [LAW:single-enforcer] All chain-related identity and projection rules live
// here. messageIdentity is the canonical hash for "are these two messages
// the same one in the conversation" — Stage B's dedupe and Stage C's
// system-prompt and chain-diff views all share it.
//
// [LAW:dataflow-not-control-flow] Live and replay paths feed the same
// projection; same RequestRecord shape in, same TimelineEntry[] out. There
// is no "is this live vs replay" branch.
//
// [LAW:types-are-the-program] TimelineEntry is a discriminated union; every
// downstream consumer narrows on `kind` and the type provides the variant's
// fields. No optional field is set "based on what kind of entry it is" —
// the variant carries its own shape.

import type {
  AnthropicContentBlock,
  AnthropicUsage,
  RequestRecord,
} from "../../../shared/proxy-events";

// ─── Identity ─────────────────────────────────────────────────────────────

// Returns a stable string identity for a message reference. Two messages
// with semantically-equal content (same role, same content blocks in the
// same order, regardless of object key insertion order in the JSON) yield
// the same identity. A message that carries its own string `id` field uses
// that id verbatim (Anthropic assistant messages preserve their
// `message_start.id` in `assembledResponse`).
//
// The implementation uses an FNV-1a 64-bit hash of the stable-JSON
// serialization — sufficient collision resistance for human-readable
// conversation content; synchronous (Web Crypto's digest is async and
// would force pure projections to become async too); deterministic across
// renderer reloads.
//
// [LAW:types-are-the-program] The function returns a string. Whether
// that string is sha1, fnv-1a, or stable-json itself is invisible to
// callers — the type is the contract.
export function messageIdentity(message: unknown): string {
  const rec = asRecord(message);
  if (rec && typeof rec.id === "string" && rec.id.length > 0) {
    return rec.id;
  }
  const stable = stableJson({ role: rec?.role, content: rec?.content });
  return fnv1a64Hex(stable);
}

// Memoized variant — useful when iterating message arrays repeatedly
// (e.g. during chain projection). Keyed on the message object reference,
// so two distinct objects with identical content still hash equally
// (cache miss the first time, hit the second).
//
// [LAW:dataflow-not-control-flow] Behavior is identical to messageIdentity;
// memoization is a performance projection, never a semantic difference.
export function makeMemoIdentity(): (message: unknown) => string {
  const cache = new WeakMap<object, string>();
  return (message) => {
    if (typeof message !== "object" || message === null) {
      return messageIdentity(message);
    }
    const hit = cache.get(message as object);
    if (hit !== undefined) return hit;
    const id = messageIdentity(message);
    cache.set(message as object, id);
    return id;
  };
}

// ─── Timeline entries ─────────────────────────────────────────────────────

export interface RequestMessageEntry {
  readonly kind: "message";
  readonly identity: string;
  readonly role: string;
  readonly content: unknown;
  readonly introducedByRequestId: string;
}

export interface AssistantResponseEntry {
  readonly kind: "assistant_response";
  readonly identity: string;
  readonly content: AnthropicContentBlock[];
  readonly producedByRequestId: string;
  // null while the request is still in-flight; populated when the
  // assembler has produced the full content.
  readonly inFlight: boolean;
}

export interface RequestBoundaryEntry {
  readonly kind: "request_boundary";
  readonly requestId: string;
  readonly stopReason: string | null;
  readonly usage: AnthropicUsage | null;
  readonly ttfbNs: number | null;
  readonly durationNs: number | null;
}

export type TimelineEntry =
  | RequestMessageEntry
  | AssistantResponseEntry
  | RequestBoundaryEntry;

// ─── Chain → Timeline ─────────────────────────────────────────────────────

// Build a deduped timeline for a chain of requests. The chain must be in
// causal order (root first, selected/leaf last) — exactly what the caller
// produces by walking `lineage.parentId` upward and reversing.
//
// Algorithm (matches docs/design/live-rich/README.md §2.2):
//   1. For each request in order:
//      a. Append each `messages[i]` whose identity is not already in the
//         set, as a `message` entry attributed to that request.
//      b. Append the assistant's `assembledResponse` (or an in-flight
//         placeholder) as an `assistant_response` entry.
//      c. Append a `request_boundary` entry with the request's stop info.
//
// [LAW:one-type-per-behavior] One function does the projection for every
// chain shape — length 1, length N, in-flight tail, fully complete — no
// branches that select different code paths by chain shape.
export function buildTimeline(chain: readonly RequestRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const seenIdentities = new Set<string>();
  const identityOf = makeMemoIdentity();

  for (const record of chain) {
    const messages = extractMessages(record.requestBody);
    for (const msg of messages) {
      const identity = identityOf(msg);
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      const role = extractRole(msg);
      const content = extractContent(msg);
      entries.push({
        kind: "message",
        identity,
        role,
        content,
        introducedByRequestId: record.requestId,
      });
    }

    const response = record.assembledResponse;
    if (response !== null) {
      // [LAW:one-type-per-behavior] Two distinct concerns here, two
      // separate pieces of data:
      //
      //   (a) Cross-request dedup of the re-sent assistant message in
      //       the NEXT request's messages[]. Anthropic's wire format
      //       omits response.id on the re-send, so the next request's
      //       messages[i] (when it's the re-send of this assistant
      //       turn) will hash as role+content alone. We seed
      //       seenIdentities with that hash so the re-send collapses
      //       into this assistant_response entry.
      //
      //   (b) Per-request attribution of THIS assistant turn. Two
      //       requests with identical content ("OK") must still each
      //       get their own assistant_response entry — otherwise the
      //       second one is silently dropped from the timeline. The
      //       entry's identity is therefore scoped to the requestId,
      //       not the content.
      //
      // Conflating the two (the prior shape) is the bug; separating
      // them keeps both invariants honest.
      const contentIdentity = identityOf({
        role: "assistant",
        content: response.content,
      });
      seenIdentities.add(contentIdentity);
      entries.push({
        kind: "assistant_response",
        identity: `asst:${record.requestId}`,
        content: response.content,
        producedByRequestId: record.requestId,
        inFlight: false,
      });
    } else if (record.state === "in_flight" || record.state === "streaming") {
      // In-flight tail: render a placeholder. Identity is the requestId
      // so a subsequent transition to `complete` can replace this entry
      // when the timeline is re-built with the next chain shape.
      entries.push({
        kind: "assistant_response",
        identity: `in-flight:${record.requestId}`,
        content: [],
        producedByRequestId: record.requestId,
        inFlight: true,
      });
    }

    // [LAW:single-enforcer] stop_reason fallback matches the rule
    // ChainStopReasonStrip uses elsewhere — a `complete` state with no
    // explicit stop_reason renders as "end_turn", not as the animated
    // in-flight chip. The two surfaces would otherwise drift.
    //
    // durationNs uses `endedNs ?? completedNs` to match
    // computeLatency() in latency.ts — errored requests populate
    // endedNs but not completedNs, and the boundary should still show
    // their duration honestly. We don't import computeLatency directly
    // because buildTimeline is a pure projection (no nowNs / no
    // useLiveTickNs); the snapshot ttfb/duration is what the boundary
    // renders, and in-flight requests render null (the UI hides the
    // slot, same as before).
    const endNs = record.endedNs ?? record.completedNs;
    entries.push({
      kind: "request_boundary",
      requestId: record.requestId,
      stopReason:
        response?.stop_reason ??
        (record.state === "complete" ? "end_turn" : null),
      usage: response?.usage ?? null,
      ttfbNs:
        record.firstByteNs !== null
          ? record.firstByteNs - record.startedNs
          : null,
      durationNs: endNs !== null ? endNs - record.startedNs : null,
    });
  }

  return entries;
}

// ─── Tool pairing ─────────────────────────────────────────────────────────

// Maps a tool_use block's id to the timeline-entry index of the message
// (or assistant_response) that contains the matching tool_result. The
// tool_result is in a later message in the chain; lookup is one-shot per
// chain.
//
// [LAW:single-enforcer] The pairing rule lives here; the ConversationTab
// reads the map and renders scroll-anchored links. No callsite hand-rolls
// "find tool_result for this tool_use".
export function buildToolPairings(
  entries: readonly TimelineEntry[],
): {
  toolUseToResult: Map<string, number>;
  toolResultToUse: Map<string, number>;
} {
  const toolUseToResult = new Map<string, number>();
  const toolResultToUse = new Map<string, number>();
  // First pass: index every tool_use's location.
  const toolUseLocations = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const blocks = blocksOfEntry(entry);
    for (const block of blocks) {
      const rec = asRecord(block);
      if (rec?.type === "tool_use" && typeof rec.id === "string") {
        toolUseLocations.set(rec.id, i);
      }
    }
  }
  // Second pass: index tool_results and resolve pairings.
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const blocks = blocksOfEntry(entry);
    for (const block of blocks) {
      const rec = asRecord(block);
      if (rec?.type === "tool_result" && typeof rec.tool_use_id === "string") {
        const toolUseIdx = toolUseLocations.get(rec.tool_use_id);
        if (toolUseIdx !== undefined) {
          toolUseToResult.set(rec.tool_use_id, i);
          toolResultToUse.set(rec.tool_use_id, toolUseIdx);
        }
      }
    }
  }
  return { toolUseToResult, toolResultToUse };
}

function blocksOfEntry(entry: TimelineEntry): readonly unknown[] {
  if (entry.kind === "message") {
    return Array.isArray(entry.content) ? entry.content : [];
  }
  if (entry.kind === "assistant_response") {
    return entry.content;
  }
  return [];
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function extractMessages(body: unknown): readonly unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const m = (body as { messages?: unknown }).messages;
  return Array.isArray(m) ? m : [];
}

function extractRole(message: unknown): string {
  const rec = asRecord(message);
  return typeof rec?.role === "string" ? rec.role : "unknown";
}

function extractContent(message: unknown): unknown {
  const rec = asRecord(message);
  return rec?.content ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Stable JSON serialization: object keys are sorted recursively so two
// objects with identical content but different insertion order yield the
// same string.
export function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + stableJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // undefined, function, symbol → omitted (matches JSON.stringify).
  return "null";
}

// Re-exported for cross-ticket consumers (ac1.6.5 system-prompt hash,
// ac1.6.8 chain diff). Same hash everywhere = same identity everywhere.
export function contentHash(value: unknown): string {
  return fnv1a64Hex(stableJson(value));
}

// Exported for golden-vector tests in conversation.test.ts. Keeping the
// raw hash addressable lets the test pin canonical FNV-1a-64 outputs
// against the bare-string inputs the algorithm is specified for,
// independent of stableJson's JSON-quoting behavior.
export { fnv1a64Hex };

// FNV-1a 64-bit. Synchronous, deterministic, no external dependency.
// Adequate collision resistance for the conversation/prompt/tools
// content we'll feed it — far below the birthday-bound risk for any
// realistic session size.
//
// Implemented with BigInt rather than split 32-bit limbs. The earlier
// limb-based version had a subtle prime-multiplication bug (double-
// counting the `<< 8` term). BigInt makes the math literally the
// algorithm. The 16-char hex result is canonical FNV-1a output.
//
// Reference test vectors — directly asserted in
// `fnv1a64Hex produces the canonical FNV-1a-64 reference vectors`
// in conversation.test.ts:
//   ""       → cbf29ce484222325   (the offset basis)
//   "a"      → af63dc4c8601ec8c
//   "foobar" → 85944171f73967e8
function fnv1a64Hex(str: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash ^ BigInt(str.charCodeAt(i))) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
