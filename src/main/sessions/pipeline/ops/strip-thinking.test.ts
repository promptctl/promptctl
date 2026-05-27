import { describe, expect, it } from "vitest";
import { stripThinking } from "./strip-thinking";
import type { Step } from "../../../../shared/types";

function buildStep(targets: number[]): Step {
  return {
    id: "test-step",
    source: "manual",
    kind: "strip-thinking",
    targets,
  };
}

function userLine(uuid: string) {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hi" },
  });
}

function assistantWithThinking(uuid: string) {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "thinking", thinking: "ponder", signature: "sig" },
        { type: "text", text: "hello" },
      ],
    },
  });
}

describe("stripThinking op", () => {
  it("strips thinking blocks from targeted lines, leaves text intact", () => {
    const source = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const result = stripThinking(source, buildStep([1]), source);
    const lines = result.split("\n").map((l) => JSON.parse(l));
    const blocks = lines[1].message.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
  });

  it("leaves non-targeted lines byte-for-byte intact", () => {
    const source = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const result = stripThinking(source, buildStep([1]), source);
    // The user line is untouched — same raw string.
    expect(result.split("\n")[0]).toBe(userLine("u1"));
  });

  it("no-op when no targets resolve to known uuids", () => {
    const source = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const result = stripThinking(source, buildStep([99]), source);
    expect(result).toBe(source);
  });

  it("preserves the raw line byte-for-byte when the targeted message has no thinking blocks to strip", () => {
    // Targeting a message that already has no thinking blocks is a no-op.
    // We must NOT re-serialize the line — JSON.stringify can shuffle key
    // order or whitespace, producing a spurious diff for no semantic change.
    const textOnlyAssistant = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: null,
      isSidechain: false,
      cwd: "/r",
      sessionId: "s",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "no thinking here" }],
      },
    });
    const source = [userLine("u1"), textOnlyAssistant].join("\n");
    const result = stripThinking(source, buildStep([1]), source);
    // Byte-for-byte identical.
    expect(result).toBe(source);
  });

  it("resolves targets against source even when running content differs", () => {
    // Simulate: an earlier pipeline step removed line index 0 from the
    // running content, but the strip-thinking step still targets source
    // index 1 (the assistant). With UUID-anchored resolution, the
    // assistant line in the running content is still found and stripped.
    const source = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const running = assistantWithThinking("a1"); // u1 already removed
    const result = stripThinking(running, buildStep([1]), source);
    const blocks = (JSON.parse(result) as { message: { content: { type: string }[] } })
      .message.content;
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
  });
});
