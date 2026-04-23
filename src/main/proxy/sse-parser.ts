// [LAW:single-enforcer] Sole SSE wire-format → typed SseEvent boundary.
// Anywhere else in the codebase that wants typed SSE events MUST go through
// here. Live mode pipes the upstream response body through SseParser; replay
// mode synthesizes typed events directly (skipping the byte format).
//
// Wire format (per W3C EventSource spec, as used by Anthropic):
//
//   event: message_start
//   data: {"type":"message_start", ...}
//
//   event: content_block_delta
//   data: {"type":"content_block_delta", ...}
//
// Frames are separated by a blank line (\n\n). Each line within a frame is
// a `field: value` pair. Anthropic uses only `event:` and `data:` fields.
import { Transform, type TransformCallback } from "node:stream";

import type { SseEvent } from "../../shared/proxy-events";

// `ping` events are valid in the wire stream but carry no semantic payload.
// We drop them at this boundary so downstream code doesn't need to filter.
const DROPPED_EVENT_TYPES = new Set(["ping"]);

// Known event types we can structurally validate. Unknown types throw —
// per scripting-discipline, silent drop hides API drift.
const KNOWN_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

interface ParsedFrame {
  event: string | null;
  data: string | null;
}

function parseFrame(frame: string): ParsedFrame {
  const out: ParsedFrame = { event: null, data: null };
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comments per SSE spec
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    // Per spec, single space after colon is stripped if present.
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") out.event = value;
    else if (field === "data") out.data = out.data === null ? value : `${out.data}\n${value}`;
  }
  return out;
}

// [LAW:dataflow-not-control-flow] Frame payload is parsed and shape-checked
// here; the SseEvent union narrows on `type`. Callers never re-validate.
export function parseSseFrame(frame: string): SseEvent | null {
  const parsed = parseFrame(frame);
  if (parsed.event === null || parsed.data === null) return null;
  if (DROPPED_EVENT_TYPES.has(parsed.event)) return null;
  if (!KNOWN_EVENT_TYPES.has(parsed.event)) {
    throw new Error(`Unknown SSE event type: ${parsed.event}`);
  }
  const payload = JSON.parse(parsed.data) as { type?: string };
  if (payload.type !== parsed.event) {
    // Anthropic sends matching `event:` and `data.type` — a divergence here
    // means something is wrong upstream or in our parsing; fail loud.
    throw new Error(
      `SSE event/data type mismatch: event=${parsed.event} data.type=${payload.type ?? "?"}`,
    );
  }
  // Discriminated union narrows on `type`; trust Anthropic's wire format.
  return payload as SseEvent;
}

// SseParser is a Transform stream: bytes in (Buffer chunks), SseEvent objects
// out (in object mode). Buffers across chunk boundaries so a frame split mid-
// flight reassembles correctly.
export class SseParser extends Transform {
  private buffer = "";

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Frames are terminated by \n\n. Find each terminator and emit.
    let idx = this.buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      try {
        const event = parseSseFrame(frame);
        if (event !== null) this.push(event);
      } catch (err) {
        cb(err as Error);
        return;
      }
      idx = this.buffer.indexOf("\n\n");
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    // Trailing partial frame (no terminator) is dropped — it was never
    // complete. This matches EventSource semantics.
    this.buffer = "";
    cb();
  }
}
