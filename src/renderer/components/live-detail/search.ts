// [LAW:one-source-of-truth] RequestRecord stays canonical; the search
// index is a renderer-side derivation of the text content already
// present in record.requestBody and record.assembledResponse. No new
// IPC channel, no parallel store slice — the index is a cache that
// rebuilds from the records themselves.
//
// [LAW:single-enforcer] One module owns "is this record a search
// match" — searchText / recordMatchesSearch / splitHighlights. Every
// callsite (visibleRequests-callers, RequestRow, block renderers,
// RawTab) consumes through these. No bespoke substring checks
// scattered across the live-detail components.
//
// [LAW:dataflow-not-control-flow] Live and replay produce identical
// searchText for identical records — searchText reads from the same
// RequestRecord shape both paths emit. Cache invalidation is keyed
// on (requestId, state); the same state transition fires the same
// rebuild whether the event came from a live SSE stream or a replay.

import { useEffect, useMemo, useRef } from "react";
import type { RequestRecord, RequestRecordState } from "../../../shared/proxy-events";
import { useProxyStore } from "../../store/proxy";

export interface SearchIndex {
  get(record: RequestRecord): string;
}

// Lowercased haystack derived from a record. Concatenates url +
// system + per-message text + tools + assembled response content
// (design §8.1). Lowercased exactly once at the join so per-record
// downstream consumers can call `.includes(normalizedQuery)` without
// re-lowercasing per-row.
export function searchText(record: RequestRecord): string {
  const parts: string[] = [];
  parts.push(record.url);
  collectFromRequestBody(record.requestBody, parts);
  const response = record.assembledResponse;
  if (response !== null && Array.isArray(response.content)) {
    for (const block of response.content) collectFromBlock(block, parts);
  }
  return parts.join(" ").toLowerCase();
}

// Normalize a raw query string for comparison. Trim is necessary
// because the input event delivers raw text; lowercase mirrors
// searchText so `.includes` is case-insensitive by construction.
// Empty string is the canonical "no query" value — it never matches
// because callers short-circuit on it.
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

export function recordMatchesSearch(
  record: RequestRecord,
  normalizedQuery: string,
  index: SearchIndex,
): boolean {
  if (normalizedQuery === "") return true;
  return index.get(record).includes(normalizedQuery);
}

// Split text into alternating {text, isMatch} segments for rendering
// with <mark> around matches. Query matching is case-insensitive but
// the original case of `text` is preserved in the output segments
// (the user sees the source text, not the normalized form).
//
// Empty query yields a single non-match segment for the entire
// string — callers can render the result without a query-active
// branch.
export interface HighlightSegment {
  text: string;
  isMatch: boolean;
}

export function splitHighlights(
  text: string,
  normalizedQuery: string,
): HighlightSegment[] {
  if (normalizedQuery === "" || text === "") {
    return [{ text, isMatch: false }];
  }
  const haystack = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  const queryLength = normalizedQuery.length;
  let cursor = 0;
  while (cursor < text.length) {
    const matchIndex = haystack.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), isMatch: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), isMatch: false });
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + queryLength),
      isMatch: true,
    });
    cursor = matchIndex + queryLength;
  }
  return segments;
}

// React hook that owns the search-index cache. Cache key is
// (requestId, state) — once a record reaches a terminal state
// (complete/errored), its searchText is computed once and reused;
// in-flight and streaming records recompute on each lookup (their
// content is still arriving and any cached value would be stale).
//
// The index reference returned is stable for the component's
// lifetime so memoization deps on `index` don't churn.
export function useSearchIndex(): SearchIndex {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  // Prune cache entries whose record was evicted from the store
  // (MAX_REQUESTS trim). Subscribing instead of polling means the
  // cache shape tracks state.requests without per-call overhead in
  // the hot `get` path.
  useEffect(() => {
    const unsub = useProxyStore.subscribe((state, prev) => {
      if (state.requests === prev.requests) return;
      const cache = cacheRef.current;
      for (const id of cache.keys()) {
        if (!state.requests.has(id)) cache.delete(id);
      }
    });
    return unsub;
  }, []);

  return useMemo<SearchIndex>(
    () => ({
      get(record) {
        const cache = cacheRef.current;
        const cached = cache.get(record.requestId);
        if (
          cached !== undefined &&
          cached.state === record.state &&
          isTerminal(record.state)
        ) {
          return cached.text;
        }
        const text = searchText(record);
        cache.set(record.requestId, { state: record.state, text });
        return text;
      },
    }),
    [],
  );
}

interface CacheEntry {
  state: RequestRecordState;
  text: string;
}

function isTerminal(state: RequestRecordState): boolean {
  return state === "complete" || state === "errored";
}

function collectFromRequestBody(body: unknown, out: string[]): void {
  if (!isObjectRecord(body)) return;
  collectFromSystem(body.system, out);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) collectFromMessage(message, out);
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) collectFromTool(tool, out);
  }
}

function collectFromSystem(system: unknown, out: string[]): void {
  if (typeof system === "string") {
    out.push(system);
    return;
  }
  if (Array.isArray(system)) {
    for (const item of system) {
      const rec = asRecord(item);
      if (rec && typeof rec.text === "string") out.push(rec.text);
    }
  }
}

function collectFromMessage(message: unknown, out: string[]): void {
  const rec = asRecord(message);
  if (rec === null) return;
  const content = rec.content;
  if (typeof content === "string") {
    out.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) collectFromBlock(block, out);
  }
}

function collectFromTool(tool: unknown, out: string[]): void {
  const rec = asRecord(tool);
  if (rec === null) return;
  if (typeof rec.name === "string") out.push(rec.name);
  if (typeof rec.description === "string") out.push(rec.description);
}

// Pulls human-readable text from a content block. tool_use input is
// serialized via JSON.stringify so the user can search for argument
// values they remember (path fragments, SQL keywords, etc.) — the
// detail-tab highlight doesn't have to mark inside the structured
// view; the row-level match cue is sufficient.
function collectFromBlock(block: unknown, out: string[]): void {
  const rec = asRecord(block);
  if (rec === null) return;
  const type = rec.type;
  if (type === "text" && typeof rec.text === "string") {
    out.push(rec.text);
    return;
  }
  if (type === "thinking" && typeof rec.thinking === "string") {
    out.push(rec.thinking);
    return;
  }
  if (type === "tool_use") {
    if (typeof rec.name === "string") out.push(rec.name);
    if (typeof rec.id === "string") out.push(rec.id);
    if (rec.input !== undefined) {
      try {
        out.push(JSON.stringify(rec.input));
      } catch {
        // Skip unserializable inputs (cyclic refs) — the row stays
        // searchable via the other parts of the record.
      }
    }
    return;
  }
  if (type === "tool_result") {
    if (typeof rec.tool_use_id === "string") out.push(rec.tool_use_id);
    const content = rec.content;
    if (typeof content === "string") {
      out.push(content);
    } else if (Array.isArray(content)) {
      for (const child of content) collectFromBlock(child, out);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}
