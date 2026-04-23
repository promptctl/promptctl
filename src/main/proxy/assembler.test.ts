// @vitest-environment node
import { describe, it, expect } from "vitest";

import type { SseEvent } from "../../shared/proxy-events";
import { ResponseAssembler } from "./assembler";

// Helper — synth a typical "Hello, Claude" two-text-block response.
function helloEvents(): SseEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world!" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 6 },
    },
    { type: "message_stop" },
  ];
}

describe("ResponseAssembler", () => {
  it("reconstructs a simple text-only message", () => {
    const a = new ResponseAssembler();
    for (const ev of helloEvents()) a.onEvent(ev);
    const msg = a.complete();
    expect(msg).toEqual({
      id: "msg_test1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "Hello, world!" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it("reconstructs tool_use input from input_json_delta chunks", () => {
    const a = new ResponseAssembler();
    a.onEvent({
      type: "message_start",
      message: {
        id: "msg_tool1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    a.onEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    a.onEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Looking up the weather." },
    });
    a.onEvent({ type: "content_block_stop", index: 0 });
    a.onEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    });
    a.onEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"location":' },
    });
    a.onEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"NYC"}' },
    });
    a.onEvent({ type: "content_block_stop", index: 1 });
    a.onEvent({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 32 },
    });
    a.onEvent({ type: "message_stop" });

    const msg = a.complete();
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toEqual([
      { type: "text", text: "Looking up the weather." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "NYC" } },
    ]);
  });

  it("preserves block order even if start arrives out of order (last write wins per index)", () => {
    // Anthropic guarantees ordered indices, but the assembler should not
    // assume insertion order — content[] is sorted by SSE index.
    const a = new ResponseAssembler();
    a.onEvent({
      type: "message_start",
      message: {
        id: "msg_ord",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    a.onEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });
    a.onEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "second" },
    });
    a.onEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    a.onEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "first" },
    });
    a.onEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    a.onEvent({ type: "message_stop" });

    const msg = a.complete();
    expect(msg.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("passes through unknown content block types opaquely", () => {
    const a = new ResponseAssembler();
    a.onEvent({
      type: "message_start",
      message: {
        id: "msg_thinking",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    a.onEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "deliberating", signature: "abc" },
    });
    a.onEvent({ type: "content_block_stop", index: 0 });
    a.onEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    a.onEvent({ type: "message_stop" });

    const msg = a.complete();
    expect(msg.content[0]).toMatchObject({ type: "thinking", thinking: "deliberating" });
  });

  it("throws if complete() is called before message_stop", () => {
    const a = new ResponseAssembler();
    a.onEvent({
      type: "message_start",
      message: {
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    expect(() => a.complete()).toThrow(/before message_stop/);
  });

  it("throws if a delta arrives for an unknown block index", () => {
    const a = new ResponseAssembler();
    a.onEvent({
      type: "message_start",
      message: {
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    expect(() =>
      a.onEvent({
        type: "content_block_delta",
        index: 99,
        delta: { type: "text_delta", text: "x" },
      }),
    ).toThrow(/unknown index 99/);
  });
});
