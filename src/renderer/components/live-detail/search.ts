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
// [LAW:one-way-deps] This module is pure — no React, no store import.
// The cache + subscription live in useSearchIndex.ts so the
// dependency edge runs useSearchIndex.ts → {search.ts, store/proxy.ts}
// with no return arrow. That keeps proxy.ts free to import the
// types and predicates here without dragging React into the store.

import type { RequestRecord } from "../../../shared/proxy-events";

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

// Trim + lowercase the raw input. Lowercase mirrors searchText so
// `.includes` is case-insensitive by construction. Empty string is
// the canonical "no query" value — recordMatchesSearch interprets
// it as match-all so callers don't have to branch.
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
