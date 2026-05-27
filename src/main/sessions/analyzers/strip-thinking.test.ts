// Unit tests for the Strip Thinking analyzer. Tests are organized as one
// flag-condition per test so a failure points directly at which trigger
// regressed: missing signature, empty signature, malformed shape, or
// non-Anthropic model.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripThinkingAnalyzer } from "./strip-thinking";

let dir: string;
let fp: string;

beforeEach(async () => {
  dir = path.join(
    tmpdir(),
    `pctl-strip-thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  fp = path.join(dir, "session.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function write(lines: object[]): Promise<void> {
  return writeFile(fp, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
}

function userLine(uuid: string, content = "hi") {
  return {
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantLine(
  uuid: string,
  blocks: object[],
  model = "claude-sonnet-4-5-20250929",
) {
  return {
    type: "assistant",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", model, content: blocks },
  };
}

describe("stripThinkingAnalyzer", () => {
  it("emits no recommendations when all thinking blocks have valid signatures and claude model", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [
        { type: "thinking", thinking: "", signature: "sig-1-valid" },
        { type: "text", text: "hello" },
      ]),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations).toHaveLength(0);
  });

  it("flags an assistant message whose thinking block has no signature field", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [{ type: "thinking", thinking: "" }]),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations).toHaveLength(1);
    // Logical index = the visible-message index. u1 is index 0, a1 is index 1.
    expect(result.recommendations[0].step.targets).toEqual([1]);
  });

  it("flags an assistant message whose thinking signature is empty string", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [
        { type: "thinking", thinking: "", signature: "" },
      ]),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations[0].step.targets).toEqual([1]);
  });

  it("flags an assistant message whose thinking shape is malformed (thinking is array)", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [
        { type: "thinking", thinking: ["not", "a", "string"], signature: "sig" },
      ]),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations[0].step.targets).toEqual([1]);
  });

  it("flags an assistant message from a non-Anthropic origin (model not starting with claude-)", async () => {
    await write([
      userLine("u1"),
      assistantLine(
        "a1",
        [
          // Even with a perfectly-shaped thinking block, non-claude origin
          // means the signature isn't Anthropic-issued and won't replay.
          { type: "thinking", thinking: "x", signature: "sig-1" },
        ],
        "gpt-5",
      ),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations[0].step.targets).toEqual([1]);
  });

  it("emits ONE recommendation targeting all flagged indices (not one per message)", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [{ type: "thinking", thinking: "" }]),
      userLine("u2"),
      assistantLine("a2", [{ type: "thinking", signature: "" }]),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].step.targets).toEqual([1, 3]);
    expect(result.recommendations[0].step.kind).toBe("strip-thinking");
    expect(result.recommendations[0].step.source).toBe("strip-thinking");
  });

  it("skips assistant messages without thinking blocks (nothing to strip)", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [{ type: "text", text: "hi" }], "gpt-5"),
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations).toHaveLength(0);
  });

  it("skips user messages even when they hypothetically had model fields", async () => {
    await write([
      userLine("u1"),
      // Hand-crafted user line with a model field — analyzer should ignore.
      {
        type: "user",
        uuid: "u2",
        parentUuid: null,
        isSidechain: false,
        cwd: "/r",
        sessionId: "s",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: "x",
          model: "gpt-5",
        },
      },
    ]);
    const result = await stripThinkingAnalyzer.run(fp);
    expect(result.recommendations).toHaveLength(0);
  });

  it("is deterministic: same input produces identical recommendations", async () => {
    await write([
      userLine("u1"),
      assistantLine("a1", [{ type: "thinking", thinking: "" }]),
      assistantLine(
        "a2",
        [{ type: "thinking", signature: "sig" }],
        "openai/gpt-4",
      ),
    ]);
    const a = await stripThinkingAnalyzer.run(fp);
    const b = await stripThinkingAnalyzer.run(fp);
    expect(a).toEqual(b);
  });
});
