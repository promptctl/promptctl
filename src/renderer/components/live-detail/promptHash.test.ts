// [LAW:behavior-not-structure] Tests assert what the functions
// produce for given inputs (determinism, clustering equivalence,
// nullity) — never how the hash is implemented underneath. Swapping
// from FNV-1a to sha256 would be allowed by these tests as long as
// the same-in-same-out property holds.

import { describe, expect, it } from "vitest";
import {
  extractSystem,
  extractTools,
  shortHash,
  systemPromptHash,
  toolsHash,
} from "./promptHash";

describe("systemPromptHash", () => {
  it("returns null when the body has no system field", () => {
    expect(systemPromptHash({ messages: [] })).toBeNull();
    expect(systemPromptHash(null)).toBeNull();
    expect(systemPromptHash("not an object")).toBeNull();
    expect(systemPromptHash({ system: "" })).toBeNull();
    expect(systemPromptHash({ system: [] })).toBeNull();
  });

  it("is deterministic across calls and object-key insertion order", () => {
    const a = { system: "You are Claude Code", model: "claude" };
    const b = { model: "claude", system: "You are Claude Code" };
    expect(systemPromptHash(a)).toBe(systemPromptHash(b));
  });

  it("hashes string and array forms separately (different shapes → different hashes)", () => {
    // Two requests with the same prompt text but different serialization
    // shapes really are different from the API's perspective (caching,
    // cache_control attribution). The hash reflects that.
    const asString = { system: "You are Claude." };
    const asArray = { system: [{ type: "text", text: "You are Claude." }] };
    expect(systemPromptHash(asString)).not.toBe(systemPromptHash(asArray));
  });

  it("clusters: 3 requests with 2 distinct prompts produce 2 distinct hashes", () => {
    const promptA = { system: "Prompt A" };
    const promptB = { system: "Prompt B" };
    const hashes = new Set(
      [promptA, promptA, promptB].map((req) => systemPromptHash(req)),
    );
    expect(hashes.size).toBe(2);
  });

  it("is stable when the surrounding body changes but the system field doesn't", () => {
    const a = { system: "S", messages: [{ role: "user", content: "hi" }] };
    const b = { system: "S", messages: [{ role: "user", content: "bye" }] };
    expect(systemPromptHash(a)).toBe(systemPromptHash(b));
  });
});

describe("toolsHash", () => {
  it("returns null when tools are absent or empty", () => {
    expect(toolsHash({ system: "x" })).toBeNull();
    expect(toolsHash({ tools: [] })).toBeNull();
    expect(toolsHash(null)).toBeNull();
  });

  it("is deterministic for equivalent tool arrays", () => {
    const tools = [
      { name: "Bash", description: "Run a command" },
      { name: "Read", description: "Read a file" },
    ];
    expect(toolsHash({ tools })).toBe(toolsHash({ tools: [...tools] }));
  });

  it("treats tool order as semantic (order changes → hash changes)", () => {
    // Anthropic's API treats tool order as part of the cache key,
    // so we must too.
    const t1 = [{ name: "Bash" }, { name: "Read" }];
    const t2 = [{ name: "Read" }, { name: "Bash" }];
    expect(toolsHash({ tools: t1 })).not.toBe(toolsHash({ tools: t2 }));
  });
});

describe("extractSystem", () => {
  it("returns the string when system is a non-empty string", () => {
    expect(extractSystem({ system: "hello" })).toBe("hello");
  });

  it("returns the array when system is a non-empty array", () => {
    const arr = [{ type: "text", text: "x" }];
    expect(extractSystem({ system: arr })).toBe(arr);
  });

  it("returns null for empty string, empty array, or absent field", () => {
    expect(extractSystem({ system: "" })).toBeNull();
    expect(extractSystem({ system: [] })).toBeNull();
    expect(extractSystem({})).toBeNull();
  });
});

describe("extractTools", () => {
  it("returns the array when tools is non-empty", () => {
    const tools = [{ name: "Bash" }];
    expect(extractTools({ tools })).toBe(tools);
  });

  it("returns null for empty or absent tools", () => {
    expect(extractTools({ tools: [] })).toBeNull();
    expect(extractTools({})).toBeNull();
  });
});

describe("shortHash", () => {
  it("returns the first 7 chars of the hash", () => {
    expect(shortHash("abcdef1234567890")).toBe("abcdef1");
  });
});
