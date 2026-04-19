import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claudeAdapter } from "./adapter";
import type { CompressToolsOptions } from "../../../shared/types";

// Test presets — threshold configs that force one strategy or the other, so
// tests can exercise a single path at a time even though production dispatches
// by token count.
const TRUNCATE_ONLY: CompressToolsOptions = {
  summarizeThreshold: Number.MAX_SAFE_INTEGER,
  truncateThreshold: 1000,
  keepLastN: 3,
};
const SUMMARIZE_ONLY: CompressToolsOptions = {
  summarizeThreshold: 1000,
  truncateThreshold: 1000,
  keepLastN: 3,
};

// --- Test fixtures: realistic JSONL lines ---

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function userMessage(text: string, opts: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: opts.uuid ?? crypto.randomUUID(),
    timestamp: opts.timestamp ?? "2025-01-01T00:00:00Z",
    message: { role: "user", content: text },
    ...opts,
  };
}

function assistantText(text: string, opts: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: opts.uuid ?? crypto.randomUUID(),
    timestamp: opts.timestamp ?? "2025-01-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-4-20250514",
      ...(opts.message as Record<string, unknown> ?? {}),
    },
    ...opts,
  };
}

function assistantThinking(thinking: string, opts: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: opts.uuid ?? crypto.randomUUID(),
    timestamp: opts.timestamp ?? "2025-01-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      model: "claude-sonnet-4-20250514",
    },
    ...opts,
  };
}

function assistantWithThinkingAndText(thinking: string, text: string) {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    timestamp: "2025-01-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
      model: "claude-sonnet-4-20250514",
    },
  };
}

function assistantToolUse(name: string, input: unknown) {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    timestamp: "2025-01-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input, id: `tool_${crypto.randomUUID()}` }],
      model: "claude-sonnet-4-20250514",
    },
  };
}

function toolResult(content: string, toolUseId?: string) {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    timestamp: "2025-01-01T00:01:30Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId ?? `tool_${crypto.randomUUID()}`,
          content,
        },
      ],
    },
  };
}

function systemMessage(text: string) {
  return {
    type: "system",
    uuid: crypto.randomUUID(),
    timestamp: "2025-01-01T00:00:00Z",
    message: { role: "system", content: text },
  };
}

// --- Helpers ---

let tmpDir: string;

async function writeSession(...lines: Record<string, unknown>[]): Promise<string> {
  const filePath = path.join(tmpDir, "test-session.jsonl");
  await writeFile(filePath, jsonl(...lines), "utf-8");
  return filePath;
}

// The adapter interface declares compressToolResults optional so test stubs can
// skip it, but the Claude adapter always implements it. Narrow once here.
function compress(
  ...args: Parameters<NonNullable<typeof claudeAdapter.compressToolResults>>
): ReturnType<NonNullable<typeof claudeAdapter.compressToolResults>> {
  if (!claudeAdapter.compressToolResults) {
    throw new Error("claude adapter must implement compressToolResults");
  }
  return claudeAdapter.compressToolResults(...args);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "promptctl-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// Token counting: billable tokens only
// ============================================================

describe("token counting", () => {
  it("counts user text message tokens from content, not JSON metadata", async () => {
    const text = "Please help me fix this bug in my code";
    const fp = await writeSession(userMessage(text));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(1);
    // Tokens should be roughly the text length, not the full JSON line
    // The full JSON line includes uuid, timestamp, type, etc.
    // A 38-char message should be ~10 tokens, not ~50+
    expect(msgs[0].tokens).toBeLessThan(20);
    expect(msgs[0].tokens).toBeGreaterThan(0);
  });

  it("excludes thinking block tokens entirely", async () => {
    const longThinking = "Let me reason step by step. ".repeat(200);
    const fp = await writeSession(assistantThinking(longThinking));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].tokens).toBe(0);
  });

  it("counts only the text portion when thinking + text are mixed", async () => {
    const thinking = "Internal reasoning ".repeat(100);
    const text = "Here is my answer.";
    const fp = await writeSession(assistantWithThinkingAndText(thinking, text));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(1);
    // Should only count "Here is my answer." — a few tokens
    expect(msgs[0].tokens).toBeLessThan(15);
    expect(msgs[0].tokens).toBeGreaterThan(0);
  });

  it("counts tool_use name and input", async () => {
    const fp = await writeSession(
      assistantToolUse("Read", { file_path: "/src/main.ts" }),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].tokens).toBeGreaterThan(0);
  });

  it("counts tool_result content", async () => {
    const content = "function main() { console.log('hello'); }";
    const fp = await writeSession(toolResult(content));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].tokens).toBeGreaterThan(0);
  });
});

// ============================================================
// Flag detection
// ============================================================

describe("flags", () => {
  it("flags thinking-only messages", async () => {
    const fp = await writeSession(assistantThinking("some deep thought"));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).toContain("thinking");
  });

  it("does not flag messages with thinking + text as thinking-only", async () => {
    const fp = await writeSession(
      assistantWithThinkingAndText("reasoning", "Here is the answer"),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).not.toContain("thinking");
  });

  it("flags system messages as system-noise", async () => {
    const fp = await writeSession(systemMessage("System init"));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).toContain("system-noise");
  });

  it("flags tool calls as tool-output", async () => {
    const fp = await writeSession(
      assistantToolUse("Bash", { command: "ls" }),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).toContain("tool-output");
  });

  it("flags oversized messages (>10k tokens)", async () => {
    const hugeContent = "word ".repeat(20_000);
    const fp = await writeSession(toolResult(hugeContent));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).toContain("oversized");
  });

  it("does not flag thinking-only as oversized even with large thinking", async () => {
    const hugeThinking = "reasoning ".repeat(20_000);
    const fp = await writeSession(assistantThinking(hugeThinking));
    const msgs = await claudeAdapter.loadSession(fp);

    // 0 billable tokens → no oversized flag
    expect(msgs[0].flags).not.toContain("oversized");
    expect(msgs[0].flags).toContain("thinking");
  });

  it("flags repetitive content", async () => {
    const repeated = "ERROR: connection refused. ".repeat(200);
    const fp = await writeSession(assistantText(repeated));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].flags).toContain("repetitive");
  });
});

// ============================================================
// Message type classification
// ============================================================

describe("message type classification", () => {
  it("classifies user text as 'user'", async () => {
    const fp = await writeSession(userMessage("hello"));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].type).toBe("user");
  });

  it("classifies assistant messages as 'assistant'", async () => {
    const fp = await writeSession(assistantText("hi there"));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].type).toBe("assistant");
  });

  it("classifies tool results as 'tool-result'", async () => {
    const fp = await writeSession(toolResult("some output"));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].type).toBe("tool-result");
  });

  it("classifies system messages as 'system'", async () => {
    const fp = await writeSession(systemMessage("init"));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].type).toBe("system");
  });
});

// ============================================================
// Preview extraction
// ============================================================

describe("preview extraction", () => {
  it("extracts user text as preview", async () => {
    const fp = await writeSession(userMessage("Fix the login page"));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview).toContain("Fix the login page");
  });

  it("extracts assistant text as preview", async () => {
    const fp = await writeSession(assistantText("I'll help you with that."));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview).toContain("I'll help you with that.");
  });

  it("shows [thinking] for thinking-only messages", async () => {
    const fp = await writeSession(assistantThinking("let me think..."));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview).toBe("[thinking]");
  });

  it("shows tool names for tool-use-only messages", async () => {
    const fp = await writeSession(assistantToolUse("Read", { path: "/foo" }));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview).toContain("Read");
  });

  it("truncates long previews", async () => {
    const longText = "x".repeat(500);
    const fp = await writeSession(userMessage(longText));
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview.length).toBeLessThanOrEqual(300);
  });

  it("shows tool result content as preview (truncated)", async () => {
    const fp = await writeSession(
      toolResult("function main() { console.log('hello'); return 42; }"),
    );
    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs[0].preview).toContain("function main");
    expect(msgs[0].preview).toContain("console.log");
  });
});

// ============================================================
// Auto-trim suggestions
// ============================================================

describe("autoTrimSuggestions", () => {
  it("suggests removing repetitive messages", async () => {
    const repeated = "ERROR: timeout. ".repeat(200);
    const fp = await writeSession(
      userMessage("help me"),
      assistantText(repeated),
      userMessage("thanks"),
    );
    await claudeAdapter.loadSession(fp);
    const suggestions = claudeAdapter.autoTrimSuggestions();

    // The repetitive assistant message (index 1) should be suggested
    expect(suggestions).toContain(1);
    // User messages should not be suggested
    expect(suggestions).not.toContain(0);
    expect(suggestions).not.toContain(2);
  });

  it("suggests removing system noise", async () => {
    const fp = await writeSession(
      userMessage("hello"),
      systemMessage("system info"),
      assistantText("hi"),
    );
    await claudeAdapter.loadSession(fp);
    const suggestions = claudeAdapter.autoTrimSuggestions();

    expect(suggestions).toContain(1); // system message
    expect(suggestions).not.toContain(0);
    expect(suggestions).not.toContain(2);
  });

  it("returns empty for clean conversations", async () => {
    const fp = await writeSession(
      userMessage("hello"),
      assistantText("hi there, how can I help?"),
    );
    await claudeAdapter.loadSession(fp);
    const suggestions = claudeAdapter.autoTrimSuggestions();

    expect(suggestions).toHaveLength(0);
  });
});

// ============================================================
// Session loading: structural behavior
// ============================================================

describe("loadSession", () => {
  it("skips non-visible lines (non-message types)", async () => {
    const fp = await writeSession(
      { type: "progress", content: "50%" },
      userMessage("hello"),
      { type: "custom-title", customTitle: "My session" },
      assistantText("hi"),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    // Only user + assistant are visible
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("user");
    expect(msgs[1].type).toBe("assistant");
  });

  it("skips sidechain messages", async () => {
    const fp = await writeSession(
      userMessage("hello"),
      { ...assistantText("sidechain response"), isSidechain: true },
      assistantText("main response"),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(2);
    expect(msgs[1].preview).toContain("main response");
  });

  it("assigns sequential logical indices", async () => {
    const fp = await writeSession(
      { type: "progress", content: "starting" },
      userMessage("first"),
      { type: "progress", content: "midway" },
      assistantText("second"),
      userMessage("third"),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs.map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it("handles empty/malformed lines gracefully", async () => {
    const content = [
      JSON.stringify(userMessage("hello")),
      "",
      "not valid json",
      JSON.stringify(assistantText("world")),
    ].join("\n");
    const fp = path.join(tmpDir, "test.jsonl");
    await writeFile(fp, content, "utf-8");

    const msgs = await claudeAdapter.loadSession(fp);
    expect(msgs).toHaveLength(2);
  });
});

// ============================================================
// Save session
// ============================================================

describe("saveSession", () => {
  it("removes marked messages and preserves others", async () => {
    const fp = await writeSession(
      userMessage("keep me"),
      assistantText("remove me"),
      userMessage("keep me too"),
    );
    await claudeAdapter.loadSession(fp);

    await claudeAdapter.saveSession([1]); // remove assistant message

    const saved = await readFile(fp, "utf-8");
    expect(saved).toContain("keep me");
    expect(saved).not.toContain("remove me");
    expect(saved).toContain("keep me too");
  });

  it("does NOT create a .backup file (versioning replaces backup mechanism)", async () => {
    const fp = await writeSession(userMessage("hello"), assistantText("world"));
    await claudeAdapter.loadSession(fp);

    await claudeAdapter.saveSession([0]);

    // .backup file should not exist — versioning is the new safety mechanism
    await expect(readFile(fp + ".backup", "utf-8")).rejects.toThrow();
  });

  it("preserves non-visible lines (metadata, progress, etc.)", async () => {
    const fp = await writeSession(
      { type: "custom-title", customTitle: "My Session" },
      userMessage("hello"),
      { type: "progress", content: "50%" },
      assistantText("remove this"),
    );
    await claudeAdapter.loadSession(fp);

    // Remove only the assistant message (logical index 1)
    await claudeAdapter.saveSession([1]);

    const saved = await readFile(fp, "utf-8");
    expect(saved).toContain("custom-title");
    expect(saved).toContain("progress");
    expect(saved).toContain("hello");
    expect(saved).not.toContain("remove this");
  });
});

// ============================================================
// Tool result clearing: truncate strategy
// ============================================================

describe("compressToolResults — truncate path", () => {
  it("truncates large tool results", async () => {
    const largeOutput = "line of output\n".repeat(2000);
    // 4+ tool results so the target isn't in the protected tail (last 3)
    const fp = await writeSession(
      userMessage("run the tests"),
      assistantToolUse("Bash", { command: "npm test" }),
      toolResult(largeOutput),
      assistantText("Tests passed."),
      toolResult("filler1"),
      toolResult("filler2"),
      toolResult("filler3"),
    );
    const msgs = await claudeAdapter.loadSession(fp);
    // The big tool result is at logical index 2 (user, assistant-tool-use, tool-result)
    const targetIdx = 2;
    const originalTokens = msgs[targetIdx].tokens;
    expect(originalTokens).toBeGreaterThan(1000);

    const result = await compress(
      [targetIdx],
      TRUNCATE_ONLY,
    );

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].index).toBe(targetIdx);
    expect(result.updated[0].tokens).toBeLessThan(originalTokens);
    expect(result.truncatedCount).toBe(1);
    expect(result.summarizedCount).toBe(0);
  });

  it("preserves head and tail of tool result", async () => {
    const largeOutput =
      "FIRST LINE OF OUTPUT\n" +
      "middle stuff\n".repeat(2000) +
      "LAST LINE OF OUTPUT";
    // Need at least 4 tool results so target isn't in protected tail (last 3)
    const fp = await writeSession(
      toolResult(largeOutput, "tr-target"),
      toolResult("small1"),
      toolResult("small2"),
      toolResult("small3"),
    );
    await claudeAdapter.loadSession(fp);

    await compress([0], TRUNCATE_ONLY);

    // Check in-memory state (not yet saved to disk)
    const raw = claudeAdapter.getMessageContent(0);
    expect(raw).toContain("FIRST LINE");
    expect(raw).toContain("LAST LINE");
    expect(raw).toContain("tokens omitted");
  });

  it("skips small tool results (below threshold)", async () => {
    const smallOutput = "OK";
    // 4 tool results so the target isn't protected, but the content is small
    const fp = await writeSession(
      toolResult(smallOutput),
      toolResult("filler1"),
      toolResult("filler2"),
      toolResult("filler3"),
    );
    await claudeAdapter.loadSession(fp);

    const result = await compress([0], TRUNCATE_ONLY);
    expect(result.updated).toHaveLength(0);
    expect(result.skippedTooSmall).toBeGreaterThan(0);
  });

  it("preserves the last 3 tool results (protected tail)", async () => {
    const big = "data ".repeat(5000);
    const fp = await writeSession(
      toolResult(big, "tr1"),
      toolResult(big, "tr2"),
      toolResult(big, "tr3"),
      toolResult(big, "tr4"),
      toolResult(big, "tr5"),
    );
    await claudeAdapter.loadSession(fp);

    // Try to clear all 5; expect tr3-tr5 (last 3) to be protected
    const result = await compress(
      [0, 1, 2, 3, 4],
      TRUNCATE_ONLY,
    );
    // 2 should be modified (tr1, tr2); 3 should be protected (tr3, tr4, tr5)
    expect(result.updated).toHaveLength(2);
    expect(result.skippedProtected).toBe(3);
  });

  it("updates loadedLines so save persists the truncation", async () => {
    const largeOutput = "data ".repeat(5000);
    const fp = await writeSession(
      userMessage("check this"),
      toolResult(largeOutput),
      toolResult("filler1"),
      toolResult("filler2"),
      toolResult("filler3"),
    );
    await claudeAdapter.loadSession(fp);

    await compress([1], TRUNCATE_ONLY);
    await claudeAdapter.saveSession([]);

    const saved = await readFile(fp, "utf-8");
    expect(saved).toContain("tokens omitted");
    expect(saved.length).toBeLessThan(largeOutput.length);
  });
});

// ============================================================
// Tool result compression: summarize path
// ============================================================

describe("compressToolResults — summarize path", () => {
  it("replaces large tool results with LLM summary", async () => {
    // Mock the LLM client
    const mockChat = vi.spyOn(
      await import("../../llm/client"),
      "chatComplete",
    );
    mockChat.mockResolvedValue("3 test files found, all passing.");

    const largeOutput = "test result output\n".repeat(2000);
    // Need 4 tool results so target isn't in protected tail
    const fp = await writeSession(
      toolResult(largeOutput, "tr-target"),
      toolResult("filler1"),
      toolResult("filler2"),
      toolResult("filler3"),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    const originalTokens = msgs[0].tokens;
    const result = await compress([0], SUMMARIZE_ONLY);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].tokens).toBeLessThan(originalTokens);
    expect(result.summarizedCount).toBe(1);
    expect(result.truncatedCount).toBe(0);

    const raw = claudeAdapter.getMessageContent(0);
    expect(raw).toContain("[summarized]");
    expect(raw).toContain("3 test files found");

    mockChat.mockRestore();
  });
});

// ============================================================
// Threshold-based dispatch — one call handles mixed strategies
// ============================================================

describe("compressToolResults — threshold dispatch", () => {
  it("summarizes large items, truncates medium items, skips small ones in one call", async () => {
    const mockChat = vi.spyOn(
      await import("../../llm/client"),
      "chatComplete",
    );
    mockChat.mockResolvedValue("summarized content");

    // Build sizes with headroom so the GPT-4o tokenizer's BPE merges don't
    // push us into the wrong bucket. Content is varied text (not a single
    // repeated word) so tokens ≈ words.
    const huge = Array.from({ length: 6000 }, (_, i) => `line${i}`).join(" ");
    const medium = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const small = "ok";

    // Protected tail = 3. 3 test items + 3 fillers, so test items 0..2 are not
    // in the last-N protected zone.
    const fp = await writeSession(
      toolResult(huge, "huge"),
      toolResult(medium, "medium"),
      toolResult(small, "small"),
      toolResult("pad1", "p1"),
      toolResult("pad2", "p2"),
      toolResult("pad3", "p3"),
    );
    await claudeAdapter.loadSession(fp);

    const result = await compress(
      [0, 1, 2],
      {
        summarizeThreshold: 3000,
        truncateThreshold: 200,
        keepLastN: 3,
      },
    );

    expect(result.summarizedCount).toBe(1);
    expect(result.truncatedCount).toBe(1);
    expect(result.skippedTooSmall).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);

    mockChat.mockRestore();
  });

  it("reports progress for each item processed", async () => {
    const big = "data ".repeat(2000);
    const fp = await writeSession(
      toolResult(big, "a"),
      toolResult(big, "b"),
      toolResult("pad1", "p1"),
      toolResult("pad2", "p2"),
      toolResult("pad3", "p3"),
    );
    await claudeAdapter.loadSession(fp);

    const progressCalls: { done: number; total: number }[] = [];
    const abort = new AbortController();
    const handle = {
      id: "test",
      signal: abort.signal,
      reportProgress: (done: number, total: number) =>
        progressCalls.push({ done, total }),
      throwIfCancelled: () => {
        if (abort.signal.aborted) throw new Error("cancelled");
      },
    };

    await compress([0, 1], TRUNCATE_ONLY, handle);

    // We should see an initial 0/2 and at least one done-count update per item.
    expect(progressCalls[0]).toEqual({ done: 0, total: 2 });
    expect(progressCalls[progressCalls.length - 1].done).toBe(2);
  });

  it("stops mid-loop when the task is cancelled", async () => {
    const big = "data ".repeat(2000);
    const fp = await writeSession(
      toolResult(big, "a"),
      toolResult(big, "b"),
      toolResult(big, "c"),
      toolResult("pad1", "p1"),
      toolResult("pad2", "p2"),
      toolResult("pad3", "p3"),
    );
    await claudeAdapter.loadSession(fp);

    const abort = new AbortController();
    // Abort after the first item is processed by aborting inside reportProgress.
    let processed = 0;
    const handle = {
      id: "test",
      signal: abort.signal,
      reportProgress: (done: number) => {
        if (done === 1) abort.abort();
        processed = done;
      },
      throwIfCancelled: () => {
        if (abort.signal.aborted) throw new Error("cancelled");
      },
    };

    await expect(
      compress([0, 1, 2], TRUNCATE_ONLY, handle),
    ).rejects.toThrow("cancelled");
    // At least one item was processed; the loop exited before all three.
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(processed).toBeLessThan(3);
  });
});

// ============================================================
// Extras (per-message metadata)
// ============================================================

describe("extras", () => {
  it("extracts model name from assistant messages", async () => {
    const fp = await writeSession(assistantText("hello"));
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].extras.model).toBeDefined();
    expect(msgs[0].extras.model).toContain("sonnet");
  });

  it("extracts usage info when present", async () => {
    const fp = await writeSession(
      assistantText("hello", {
        message: {
          usage: { input_tokens: 5000, output_tokens: 1500 },
        },
      }),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs[0].extras.tokens).toContain("in");
    expect(msgs[0].extras.tokens).toContain("out");
  });
});

// ============================================================
// UI metadata
// ============================================================

describe("uiMetadata", () => {
  it("has a thinking flag definition", () => {
    const flags = claudeAdapter.uiMetadata.flagDefinitions;
    expect(flags.thinking).toBeDefined();
    expect(flags.thinking.label).toBe("THINKING");
  });

  it("has all expected flag definitions", () => {
    const flags = claudeAdapter.uiMetadata.flagDefinitions;
    expect(flags.oversized).toBeDefined();
    expect(flags.repetitive).toBeDefined();
    expect(flags["tool-output"]).toBeDefined();
    expect(flags["system-noise"]).toBeDefined();
    expect(flags.thinking).toBeDefined();
  });

  it("has type styles for all message types", () => {
    const types = claudeAdapter.uiMetadata.typeStyles;
    expect(types.user).toBeDefined();
    expect(types.assistant).toBeDefined();
    expect(types["tool-result"]).toBeDefined();
    expect(types.system).toBeDefined();
  });
});

// ============================================================
// Full conversation scenario
// ============================================================

describe("realistic conversation", () => {
  it("produces correct token counts for a mixed conversation", async () => {
    const fp = await writeSession(
      userMessage("Help me understand this codebase"),
      assistantThinking("Let me analyze the structure...".repeat(50)),
      assistantWithThinkingAndText(
        "I should look at the main files first",
        "I'll start by examining the project structure.",
      ),
      assistantToolUse("Read", { file_path: "/src/index.ts" }),
      toolResult("export function main() {\n  console.log('hello');\n}\n"),
      assistantText("The main entry point exports a single function."),
    );
    const msgs = await claudeAdapter.loadSession(fp);

    expect(msgs).toHaveLength(6);

    // User message: has tokens
    expect(msgs[0].tokens).toBeGreaterThan(0);

    // Thinking-only: 0 tokens
    expect(msgs[1].tokens).toBe(0);
    expect(msgs[1].flags).toContain("thinking");

    // Thinking + text: only text tokens
    expect(msgs[2].tokens).toBeGreaterThan(0);
    expect(msgs[2].tokens).toBeLessThan(30); // just "I'll start by examining..."
    expect(msgs[2].flags).not.toContain("thinking");

    // Tool use: has tokens (tool name + input)
    expect(msgs[3].tokens).toBeGreaterThan(0);
    expect(msgs[3].flags).toContain("tool-output");

    // Tool result: has tokens
    expect(msgs[4].tokens).toBeGreaterThan(0);
    expect(msgs[4].type).toBe("tool-result");

    // Assistant text: has tokens
    expect(msgs[5].tokens).toBeGreaterThan(0);

    // Total should be reasonable — not inflated by thinking or JSON
    const total = msgs.reduce((s, m) => s + m.tokens, 0);
    expect(total).toBeLessThan(200); // small conversation
  });
});

// ============================================================
// diffContent
// ============================================================

describe("diffContent", () => {
  it("identical content produces a single unchanged entry", () => {
    const content = jsonl(
      userMessage("hello", { uuid: "u1" }),
      assistantText("hi", { uuid: "u2" }),
    );
    const diff = claudeAdapter.diffContent(content, content);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({ kind: "unchanged", count: 2 });
  });

  it("removed message produces a removed entry", () => {
    const before = jsonl(
      userMessage("keep1", { uuid: "u1" }),
      assistantText("remove me", { uuid: "u2" }),
      userMessage("keep2", { uuid: "u3" }),
    );
    const after = jsonl(
      userMessage("keep1", { uuid: "u1" }),
      userMessage("keep2", { uuid: "u3" }),
    );
    const diff = claudeAdapter.diffContent(before, after);

    // Should have unchanged + removed entries
    const removed = diff.find((d) => d.kind === "removed");
    expect(removed).toBeDefined();
    if (removed && removed.kind === "removed") {
      expect(removed.messages).toHaveLength(1);
      expect(removed.messages[0].preview).toContain("remove me");
    }
  });

  it("added message produces an added entry", () => {
    const before = jsonl(userMessage("hello", { uuid: "u1" }));
    const after = jsonl(
      userMessage("hello", { uuid: "u1" }),
      assistantText("new response", { uuid: "u2" }),
    );
    const diff = claudeAdapter.diffContent(before, after);

    const added = diff.find((d) => d.kind === "added");
    expect(added).toBeDefined();
    if (added && added.kind === "added") {
      expect(added.messages).toHaveLength(1);
      expect(added.messages[0].preview).toContain("new response");
    }
  });

  it("modified message produces a modified entry with before/after", () => {
    // Same UUID, different content
    const before = jsonl(
      userMessage("hello", { uuid: "u1" }),
      {
        type: "user",
        uuid: "tr1",
        timestamp: "2025-01-01T00:01:30Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "x",
              content: "ORIGINAL_FULL_OUTPUT",
            },
          ],
        },
      },
    );
    const after = jsonl(
      userMessage("hello", { uuid: "u1" }),
      {
        type: "user",
        uuid: "tr1",
        timestamp: "2025-01-01T00:01:30Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "x",
              content: "TRUNCATED_OUTPUT",
            },
          ],
        },
      },
    );
    const diff = claudeAdapter.diffContent(before, after);

    const modified = diff.find((d) => d.kind === "modified");
    expect(modified).toBeDefined();
    if (modified && modified.kind === "modified") {
      expect(modified.before.id).toBe("tr1");
      expect(modified.after.id).toBe("tr1");
    }
  });

  it("handles all change types in one diff", () => {
    const before = jsonl(
      userMessage("kept1", { uuid: "u1" }),
      userMessage("removed", { uuid: "u2" }),
      userMessage("kept2", { uuid: "u3" }),
    );
    const after = jsonl(
      userMessage("kept1", { uuid: "u1" }),
      userMessage("kept2", { uuid: "u3" }),
      userMessage("added", { uuid: "u4" }),
    );
    const diff = claudeAdapter.diffContent(before, after);

    const kinds = diff.map((d) => d.kind);
    expect(kinds).toContain("unchanged");
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
  });

  it("empty content vs content shows everything as added", () => {
    const after = jsonl(userMessage("first", { uuid: "u1" }));
    const diff = claudeAdapter.diffContent("", after);

    const added = diff.find((d) => d.kind === "added");
    expect(added).toBeDefined();
    if (added && added.kind === "added") {
      expect(added.messages[0].preview).toContain("first");
    }
  });
});
