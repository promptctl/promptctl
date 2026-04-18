import { describe, it, expect } from "vitest";
import { geminiAdapter } from "./adapter";

// --- Test fixtures ---

interface RawSessionFixture {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: RawMessageFixture[];
  kind: string;
  summary: string;
}

interface RawMessageFixture {
  id: string;
  timestamp: string;
  type: string;
  content?: string | Array<{ text?: string }>;
  toolCalls?: unknown[];
}

function session(...messages: RawMessageFixture[]): string {
  const s: RawSessionFixture = {
    sessionId: "test-session",
    projectHash: "abc123",
    startTime: "2025-01-01T00:00:00Z",
    lastUpdated: "2025-01-01T00:01:00Z",
    messages,
    kind: "interactive",
    summary: "Test",
  };
  return JSON.stringify(s);
}

function userMsg(id: string, text: string): RawMessageFixture {
  return {
    id,
    timestamp: "2025-01-01T00:00:00Z",
    type: "user",
    content: text,
  };
}

function geminiMsg(id: string, text: string): RawMessageFixture {
  return {
    id,
    timestamp: "2025-01-01T00:01:00Z",
    type: "gemini",
    content: [{ text }],
  };
}

// ============================================================
// diffContent
// ============================================================

describe("diffContent", () => {
  it("identical content produces a single unchanged entry", () => {
    const content = session(userMsg("u1", "hello"), geminiMsg("g1", "hi"));
    const diff = geminiAdapter.diffContent(content, content);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({ kind: "unchanged", count: 2 });
  });

  it("removed message produces a removed entry", () => {
    const before = session(
      userMsg("u1", "keep1"),
      geminiMsg("g1", "remove me"),
      userMsg("u2", "keep2"),
    );
    const after = session(userMsg("u1", "keep1"), userMsg("u2", "keep2"));
    const diff = geminiAdapter.diffContent(before, after);

    const removed = diff.find((d) => d.kind === "removed");
    expect(removed).toBeDefined();
    if (removed && removed.kind === "removed") {
      expect(removed.messages).toHaveLength(1);
      expect(removed.messages[0].preview).toContain("remove me");
    }
  });

  it("added message produces an added entry", () => {
    const before = session(userMsg("u1", "hello"));
    const after = session(userMsg("u1", "hello"), geminiMsg("g1", "new response"));
    const diff = geminiAdapter.diffContent(before, after);

    const added = diff.find((d) => d.kind === "added");
    expect(added).toBeDefined();
    if (added && added.kind === "added") {
      expect(added.messages).toHaveLength(1);
      expect(added.messages[0].preview).toContain("new response");
    }
  });

  it("modified message produces a modified entry with before/after", () => {
    const before = session(userMsg("u1", "hello"), geminiMsg("g1", "OLD"));
    const after = session(userMsg("u1", "hello"), geminiMsg("g1", "NEW"));
    const diff = geminiAdapter.diffContent(before, after);

    const modified = diff.find((d) => d.kind === "modified");
    expect(modified).toBeDefined();
    if (modified && modified.kind === "modified") {
      expect(modified.before.preview).toContain("OLD");
      expect(modified.after.preview).toContain("NEW");
    }
  });

  it("handles all change types in one diff", () => {
    const before = session(
      userMsg("u1", "kept1"),
      userMsg("u2", "removed"),
      userMsg("u3", "kept2"),
    );
    const after = session(
      userMsg("u1", "kept1"),
      userMsg("u3", "kept2"),
      userMsg("u4", "added"),
    );
    const diff = geminiAdapter.diffContent(before, after);

    const kinds = diff.map((d) => d.kind);
    expect(kinds).toContain("unchanged");
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
  });

  it("malformed content returns reasonable diff (treats malformed as empty)", () => {
    const after = session(userMsg("u1", "hello"));
    const diff = geminiAdapter.diffContent("not valid json{", after);

    const added = diff.find((d) => d.kind === "added");
    expect(added).toBeDefined();
  });
});
