// [LAW:one-source-of-truth] Hashing of system prompts and tools reuses
// the contentHash primitive from conversation.ts. Two views (deduped
// conversation timeline and the prompts panel) must agree on whether
// two requests share the "same" prompt or tools — they can only agree
// if they compute the hash the same way. The strongest theorem is
// "one hash function, used everywhere"; introducing a second function
// (even one that produces equivalent strings) would let them drift
// silently the moment either is touched.
//
// [LAW:types-are-the-program] Both functions return string | null.
// `null` means "no system prompt / no tools on this request" — a
// structural fact about the request body, lifted into the type so
// downstream code (bucket projection, UI) never needs a separate
// "isPresent" check. A bucket can only exist over present prompts.
//
// [LAW:dataflow-not-control-flow] Pure projection over requestBody.
// Live capture and HAR replay feed identical bodies; identical bodies
// produce identical hashes; the panel behaves the same on both.

import { contentHash } from "./conversation";

export function systemPromptHash(requestBody: unknown): string | null {
  const system = extractSystem(requestBody);
  if (system === null) return null;
  return contentHash(system);
}

export function toolsHash(requestBody: unknown): string | null {
  const tools = extractTools(requestBody);
  if (tools === null) return null;
  return contentHash(tools);
}

// Returns the raw system prompt value as it appears in the body, or
// null if the request has no system prompt. Accepts both the string
// form ("You are…") and the array-of-blocks form
// ([{type:"text",text:"…",cache_control:{…}}]).
export function extractSystem(requestBody: unknown): unknown | null {
  const body = asRecord(requestBody);
  if (body === null) return null;
  const system = body.system;
  if (typeof system === "string") {
    return system.length > 0 ? system : null;
  }
  if (Array.isArray(system)) {
    return system.length > 0 ? system : null;
  }
  return null;
}

// Returns the tools array, or null if the request defines no tools.
// An empty array is treated as "no tools" — same as the field being
// absent — because the bucket UI surfaces tools as a present-or-not
// signal, not an explicit empty marker.
export function extractTools(requestBody: unknown): unknown[] | null {
  const body = asRecord(requestBody);
  if (body === null) return null;
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return tools;
  return null;
}

// A short display badge derived from the hash — first 7 hex chars,
// matching the git-short-sha convention readers already recognize.
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
