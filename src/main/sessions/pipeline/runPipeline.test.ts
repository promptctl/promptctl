import { describe, expect, it } from "vitest";
import { runPipeline } from "./runPipeline";
import type { Pipeline } from "../../../shared/types";

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
        { type: "thinking", thinking: "t", signature: "sig" },
        { type: "text", text: "hi" },
      ],
    },
  });
}

describe("runPipeline", () => {
  it("returns content unchanged when pipeline is empty", () => {
    const content = userLine("u1");
    const pipeline: Pipeline = { steps: [] };
    expect(runPipeline(content, pipeline)).toBe(content);
  });

  it("applies a single strip-thinking step", () => {
    const content = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const pipeline: Pipeline = {
      steps: [
        {
          id: "s1",
          source: "manual",
          kind: "strip-thinking",
          targets: [1],
        },
      ],
    };
    const result = runPipeline(content, pipeline);
    const blocks = (
      JSON.parse(result.split("\n")[1]) as {
        message: { content: { type: string }[] };
      }
    ).message.content;
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
  });

  it("targets resolve against the ORIGINAL source even after earlier steps mutate", () => {
    // Two steps: first removes line 0 (u1), then strips thinking from line 1 (a1).
    // After step 1, u1 is gone, so index 1 no longer corresponds to a1 in the
    // running content's natural numbering. UUID-anchored resolution recovers
    // a1 via the source map, and step 2 still hits it.
    const content = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const pipeline: Pipeline = {
      steps: [
        {
          id: "s1",
          source: "manual",
          kind: "remove-messages",
          targets: [0],
        },
        {
          id: "s2",
          source: "strip-thinking",
          kind: "strip-thinking",
          targets: [1],
        },
      ],
    };
    const result = runPipeline(content, pipeline);
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const blocks = (
      JSON.parse(lines[0]) as { message: { content: { type: string }[] } }
    ).message.content;
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
  });

  it("step order matters for content (strip then remove vs remove then strip both produce the same final shape here, but interleaved targets work)", () => {
    // Verify reversing order still works — strip first then remove the
    // assistant — should produce a session with only u1.
    const content = [userLine("u1"), assistantWithThinking("a1")].join("\n");
    const pipeline: Pipeline = {
      steps: [
        {
          id: "s1",
          source: "strip-thinking",
          kind: "strip-thinking",
          targets: [1],
        },
        {
          id: "s2",
          source: "manual",
          kind: "remove-messages",
          targets: [1],
        },
      ],
    };
    const result = runPipeline(content, pipeline);
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { uuid: string }).uuid).toBe("u1");
  });
});
