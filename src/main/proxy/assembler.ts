// [LAW:single-enforcer] Sole reconstruction of streaming SSE events into the
// synthetic non-streaming AnthropicMessage shape. HAR storage and the
// response_complete event both consume this output.
//
// The Anthropic streaming protocol layout:
//   message_start              → seeds the message envelope (id, model, usage)
//   content_block_start (idx)  → opens a block at index idx
//   content_block_delta (idx)  → appends to the block at idx
//                                  text_delta       → string accumulation
//                                  input_json_delta → string scratch, parsed at stop
//   content_block_stop (idx)   → finalizes block at idx (parse tool_use input)
//   message_delta              → updates stop_reason + output_tokens
//   message_stop               → message complete
//
// Unknown content_block types pass through opaquely — we never accumulate
// deltas into them in v1 (e.g. thinking blocks). Adding richer support is a
// later slice.
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  ContentBlockStart,
  SseEvent,
} from "../../shared/proxy-events";

interface BlockState {
  start: ContentBlockStart;
  textBuffer: string; // accumulated text_delta strings (text blocks)
  inputJsonBuffer: string; // accumulated input_json_delta strings (tool_use)
}

export class ResponseAssembler {
  private message: AnthropicMessage | null = null;
  // [LAW:dataflow-not-control-flow] Sparse array indexed by SSE block index.
  // The protocol guarantees indices are dense and start at 0 within a single
  // response, but using a Map keeps assembler resilient to reorder.
  private blocks = new Map<number, BlockState>();
  private done = false;

  onEvent(event: SseEvent): void {
    if (this.done) {
      throw new Error("ResponseAssembler received event after message_stop");
    }
    switch (event.type) {
      case "message_start": {
        const m = event.message;
        this.message = {
          id: m.id,
          type: "message",
          role: m.role,
          model: m.model,
          content: [],
          stop_reason: m.stop_reason,
          stop_sequence: m.stop_sequence,
          usage: { ...m.usage },
        };
        return;
      }
      case "content_block_start": {
        this.blocks.set(event.index, {
          start: event.content_block,
          textBuffer: "",
          inputJsonBuffer: "",
        });
        return;
      }
      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        if (!block) {
          throw new Error(
            `content_block_delta for unknown index ${event.index} (no matching content_block_start)`,
          );
        }
        if (event.delta.type === "text_delta") {
          block.textBuffer += (event.delta as { text: string }).text;
        } else if (event.delta.type === "input_json_delta") {
          block.inputJsonBuffer += (
            event.delta as { partial_json: string }
          ).partial_json;
        }
        // Unknown delta types are ignored opaquely — defers thinking_delta etc.
        return;
      }
      case "content_block_stop": {
        // No-op here — we collect blocks into message.content at message_stop
        // so they are emitted in index order regardless of stop arrival order.
        return;
      }
      case "message_delta": {
        if (!this.message) {
          throw new Error("message_delta before message_start");
        }
        if (event.delta.stop_reason !== null) {
          this.message.stop_reason = event.delta.stop_reason;
        }
        if (event.delta.stop_sequence !== null) {
          this.message.stop_sequence = event.delta.stop_sequence;
        }
        this.message.usage.output_tokens = event.usage.output_tokens;
        return;
      }
      case "message_stop": {
        this.done = true;
        return;
      }
    }
  }

  // [LAW:single-enforcer] complete() is the ONLY way to materialize the
  // assembled message. It enforces that message_start was seen and finalizes
  // all blocks in index order.
  complete(): AnthropicMessage {
    if (!this.message) {
      throw new Error(
        "ResponseAssembler.complete() called before message_start",
      );
    }
    if (!this.done) {
      throw new Error(
        "ResponseAssembler.complete() called before message_stop",
      );
    }
    const indices = Array.from(this.blocks.keys()).sort((a, b) => a - b);
    const content: AnthropicContentBlock[] = indices.map((idx) => {
      const state = this.blocks.get(idx);
      // Indices come from this.blocks.keys(), so get() always returns a value.
      // The narrow is here only to satisfy strict null checking.
      if (!state)
        throw new Error(`assembler: missing block state for index ${idx}`);
      return finalizeBlock(state);
    });
    this.message.content = content;
    return this.message;
  }
}

function finalizeBlock(state: BlockState): AnthropicContentBlock {
  const start = state.start;
  if (start.type === "text") {
    return { type: "text", text: state.textBuffer };
  }
  if (start.type === "tool_use") {
    // Empty input_json_buffer is valid — Anthropic emits no deltas when the
    // input is empty {}; the start payload's `input` is the canonical value.
    const input =
      state.inputJsonBuffer.length > 0
        ? (JSON.parse(state.inputJsonBuffer) as Record<string, unknown>)
        : ((start as { input?: Record<string, unknown> }).input ?? {});
    return {
      type: "tool_use",
      id: (start as { id: string }).id,
      name: (start as { name: string }).name,
      input,
    };
  }
  // Opaque pass-through for unknown block types.
  return { ...start };
}
