import { describe, expect, it } from "vitest";
import {
  normalizeQuery,
  recordMatchesSearch,
  searchText,
  splitHighlights,
  type SearchIndex,
} from "./search";
import type {
  AnthropicMessage,
  RequestRecord,
  RequestRecordState,
} from "../../../shared/proxy-events";

function makeRecord(opts: {
  requestId?: string;
  state?: RequestRecordState;
  url?: string;
  requestBody?: unknown;
  assembledResponse?: AnthropicMessage | null;
}): RequestRecord {
  return {
    requestId: opts.requestId ?? "req-test",
    clientId: "client-test",
    method: "POST",
    url: opts.url ?? "https://api.anthropic.com/v1/messages",
    status: 200,
    startedNs: 0,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: opts.requestBody ?? null,
    assembledResponse: opts.assembledResponse ?? null,
    error: null,
    state: opts.state ?? "complete",
    events: [],
  };
}

describe("searchText", () => {
  it("is deterministic for identical records", () => {
    const record = makeRecord({
      requestBody: {
        system: "You are a helpful assistant",
        messages: [{ role: "user", content: "Refactor X" }],
      },
    });
    expect(searchText(record)).toBe(searchText(record));
  });

  it("is lowercased", () => {
    const record = makeRecord({
      requestBody: { system: "MIXED Case System Prompt" },
    });
    const text = searchText(record);
    expect(text).toBe(text.toLowerCase());
    expect(text).toContain("mixed case system prompt");
  });

  it("includes the url", () => {
    const record = makeRecord({ url: "https://api.example.com/special-path" });
    expect(searchText(record)).toContain("special-path");
  });

  it("extracts string-form system prompt", () => {
    const record = makeRecord({
      requestBody: { system: "the cake is a lie" },
    });
    expect(searchText(record)).toContain("the cake is a lie");
  });

  it("extracts array-form system prompt blocks", () => {
    const record = makeRecord({
      requestBody: {
        system: [
          { type: "text", text: "block one" },
          { type: "text", text: "block two" },
        ],
      },
    });
    const text = searchText(record);
    expect(text).toContain("block one");
    expect(text).toContain("block two");
  });

  it("extracts user message text content (string and array form)", () => {
    const stringForm = makeRecord({
      requestBody: {
        messages: [{ role: "user", content: "plain string user message" }],
      },
    });
    expect(searchText(stringForm)).toContain("plain string user message");

    const arrayForm = makeRecord({
      requestBody: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "array form block" }],
          },
        ],
      },
    });
    expect(searchText(arrayForm)).toContain("array form block");
  });

  it("extracts tool_use input as JSON so argument values are searchable", () => {
    const record = makeRecord({
      requestBody: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_x",
                name: "Bash",
                input: { command: "grep -r needle_pattern src/" },
              },
            ],
          },
        ],
      },
    });
    const text = searchText(record);
    expect(text).toContain("bash");
    expect(text).toContain("needle_pattern");
  });

  it("extracts tool_result string content and tool_use_id", () => {
    const record = makeRecord({
      requestBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_x",
                content: "stdout: discovered hayfield",
              },
            ],
          },
        ],
      },
    });
    const text = searchText(record);
    expect(text).toContain("toolu_x");
    expect(text).toContain("discovered hayfield");
  });

  it("extracts tool_result array content recursively", () => {
    const record = makeRecord({
      requestBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_y",
                content: [{ type: "text", text: "nested result text" }],
              },
            ],
          },
        ],
      },
    });
    expect(searchText(record)).toContain("nested result text");
  });

  it("extracts thinking block text", () => {
    const record = makeRecord({
      requestBody: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "internal monologue" }],
          },
        ],
      },
    });
    expect(searchText(record)).toContain("internal monologue");
  });

  it("extracts tools name + description", () => {
    const record = makeRecord({
      requestBody: {
        tools: [
          { name: "MagicTool", description: "does magical things" },
          { name: "Bash" },
        ],
      },
    });
    const text = searchText(record);
    expect(text).toContain("magictool");
    expect(text).toContain("magical things");
    expect(text).toContain("bash");
  });

  it("extracts assembled response content blocks", () => {
    const record = makeRecord({
      assembledResponse: {
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [
          { type: "text", text: "the assistant said this" },
          {
            type: "tool_use",
            id: "toolu_resp",
            name: "Read",
            input: { file_path: "/etc/secret" },
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const text = searchText(record);
    expect(text).toContain("the assistant said this");
    expect(text).toContain("/etc/secret");
    expect(text).toContain("read");
  });

  it("handles missing fields without throwing", () => {
    const empty = makeRecord({ url: "", requestBody: null });
    expect(() => searchText(empty)).not.toThrow();
  });
});

describe("normalizeQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeQuery("  HELLO  ")).toBe("hello");
  });

  it("empty / whitespace-only → empty string", () => {
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("recordMatchesSearch", () => {
  function index(text: string): SearchIndex {
    return { get: () => text };
  }

  it("empty query matches every record", () => {
    const record = makeRecord({});
    expect(recordMatchesSearch(record, "", index("anything"))).toBe(true);
  });

  it("non-empty query matches when the index contains the substring", () => {
    const record = makeRecord({});
    expect(recordMatchesSearch(record, "needle", index("haystack with needle inside"))).toBe(true);
  });

  it("non-empty query rejects when the index lacks the substring", () => {
    const record = makeRecord({});
    expect(recordMatchesSearch(record, "needle", index("only hay"))).toBe(false);
  });
});

describe("splitHighlights", () => {
  it("empty query yields a single non-match segment", () => {
    const segments = splitHighlights("the quick brown fox", "");
    expect(segments).toEqual([{ text: "the quick brown fox", isMatch: false }]);
  });

  it("empty text yields a single non-match segment", () => {
    expect(splitHighlights("", "needle")).toEqual([{ text: "", isMatch: false }]);
  });

  it("highlights a single match preserving original case", () => {
    const segments = splitHighlights("Hello, World", "world");
    expect(segments).toEqual([
      { text: "Hello, ", isMatch: false },
      { text: "World", isMatch: true },
    ]);
  });

  it("highlights multiple non-overlapping matches", () => {
    const segments = splitHighlights("aXbXc", "x");
    expect(segments).toEqual([
      { text: "a", isMatch: false },
      { text: "X", isMatch: true },
      { text: "b", isMatch: false },
      { text: "X", isMatch: true },
      { text: "c", isMatch: false },
    ]);
  });

  it("handles a match at the start", () => {
    const segments = splitHighlights("foo bar", "foo");
    expect(segments).toEqual([
      { text: "foo", isMatch: true },
      { text: " bar", isMatch: false },
    ]);
  });

  it("handles a match at the end", () => {
    const segments = splitHighlights("foo bar", "bar");
    expect(segments).toEqual([
      { text: "foo ", isMatch: false },
      { text: "bar", isMatch: true },
    ]);
  });

  it("does not infinite-loop on adjacent matches", () => {
    const segments = splitHighlights("aaaa", "aa");
    // After consuming a match of length 2, the cursor advances past it
    // so the second "aa" is also matched.
    expect(segments).toEqual([
      { text: "aa", isMatch: true },
      { text: "aa", isMatch: true },
    ]);
  });
});
