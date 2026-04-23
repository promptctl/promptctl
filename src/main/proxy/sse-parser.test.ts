// @vitest-environment node
import { describe, it, expect } from "vitest";

import { parseSseFrame, SseParser } from "./sse-parser";
import type { SseEvent } from "../../shared/proxy-events";

describe("parseSseFrame", () => {
  it("parses a message_start frame", () => {
    const frame =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-7","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0}}}';
    const ev = parseSseFrame(frame);
    expect(ev?.type).toBe("message_start");
    if (ev?.type === "message_start") {
      expect(ev.message.id).toBe("msg_1");
      expect(ev.message.model).toBe("claude-opus-4-7");
    }
  });

  it("returns null for ping events", () => {
    const frame = "event: ping\ndata: {}";
    expect(parseSseFrame(frame)).toBeNull();
  });

  it("strips a single space after the colon", () => {
    const frame = 'event:content_block_delta\ndata:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}';
    const ev = parseSseFrame(frame);
    expect(ev?.type).toBe("content_block_delta");
  });

  it("ignores comment lines", () => {
    const frame =
      ': this is a comment\nevent: message_stop\ndata: {"type":"message_stop"}';
    const ev = parseSseFrame(frame);
    expect(ev?.type).toBe("message_stop");
  });

  it("throws on unknown event types (loud failure for API drift)", () => {
    const frame = 'event: brand_new_event\ndata: {"type":"brand_new_event"}';
    expect(() => parseSseFrame(frame)).toThrow(/Unknown SSE event type/);
  });

  it("throws if event: header and data.type disagree", () => {
    const frame = 'event: message_start\ndata: {"type":"message_stop"}';
    expect(() => parseSseFrame(frame)).toThrow(/event\/data type mismatch/);
  });
});

describe("SseParser stream", () => {
  it("emits typed events as frames complete", async () => {
    const parser = new SseParser();
    const events: SseEvent[] = [];
    parser.on("data", (ev: SseEvent) => events.push(ev));

    const wire =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n' +
      '\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n' +
      '\n';

    parser.write(wire);
    parser.end();
    await new Promise((resolve) => parser.on("end", resolve));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("message_start");
    expect(events[1].type).toBe("message_stop");
  });

  it("buffers across chunk boundaries", async () => {
    const parser = new SseParser();
    const events: SseEvent[] = [];
    parser.on("data", (ev: SseEvent) => events.push(ev));

    // Split a single frame across many tiny chunks.
    const wire =
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    for (const ch of wire) parser.write(ch);
    parser.end();
    await new Promise((resolve) => parser.on("end", resolve));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_stop");
  });

  it("preserves multi-line data fields by joining with \\n", () => {
    // Anthropic doesn't currently use multiline data, but the SSE spec allows
    // multiple `data:` lines that are joined by \n. We don't have a public
    // event with multi-line data; verify the parser join logic via parseFrame.
    const frame =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message",\n' +
      'data: "role":"assistant","model":"m","stop_reason":null,"stop_sequence":null,\n' +
      'data: "usage":{"input_tokens":1,"output_tokens":0}}}';
    const ev = parseSseFrame(frame);
    expect(ev?.type).toBe("message_start");
  });

  it("propagates parse errors via the stream error event", async () => {
    const parser = new SseParser();
    let caught: Error | null = null;
    parser.on("error", (err) => {
      caught = err;
    });
    // Drain output silently — we only care about the error.
    parser.on("data", () => {
      /* drain */
    });
    parser.write('event: bogus\ndata: {"type":"bogus"}\n\n');
    await new Promise((r) => setImmediate(r));
    expect(caught).not.toBeNull();
    expect((caught as Error | null)?.message ?? "").toMatch(/Unknown SSE event type/);
  });
});
