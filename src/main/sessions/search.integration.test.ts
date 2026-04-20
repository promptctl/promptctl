// @vitest-environment node
//
// Integration tests for full-text search. These invoke the real ripgrep binary
// (bundled via @vscode/ripgrep) against real temp files. Mocking rg would just
// retest the mock — since rg IS the feature's correctness surface, we exercise
// it end-to-end.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, stat, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { searchSessions } from "./search";
import type {
  ProviderKind,
  Project,
  SessionInfo,
  SessionSearchResult,
  MessageSummary,
  DiffEntry,
} from "../../shared/types";
import type { ProviderAdapter } from "./types";
import { registerProvider, _resetRegistryForTesting } from "./registry";
import type { TaskHandle } from "../tasks/runner";

let tmpDir: string;

// --- Fixture helpers ---

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// Minimal fake provider — just enough to exercise searchSessions end-to-end
// without touching ~/.claude or ~/.gemini. Points `paths` at our tmp dir.
function makeFakeProvider(
  id: ProviderKind,
  storageDir: string,
  projectName: string,
  projectRoot: string,
): ProviderAdapter {
  return {
    id,
    uiMetadata: {
      badge: { label: id, color: "" },
      typeStyles: {},
      flagDefinitions: {},
      helpText: {
        description: "",
        resumeCommand: "",
        safeToRemove: [],
        beCareful: [],
      },
    },
    async listProjects(): Promise<Project[]> {
      return [
        {
          name: projectName,
          paths: [storageDir],
          projectRoot,
          provider: id,
        },
      ];
    },
    async listSessions(projectPaths: string[]): Promise<SessionInfo[]> {
      const out: SessionInfo[] = [];
      const { readdir } = await import("node:fs/promises");
      for (const dir of projectPaths) {
        const files = await readdir(dir).catch(() => [] as string[]);
        for (const f of files) {
          if (!f.endsWith(".jsonl") && !f.endsWith(".json")) continue;
          const filePath = path.join(dir, f);
          const st = await stat(filePath);
          out.push({
            sessionId: f.replace(/\.(jsonl|json)$/, ""),
            filePath,
            summary: `Summary of ${f}`,
            startTime: "2025-01-01T00:00:00Z",
            // Use the file's real mtime so tests can control ordering via utimes().
            lastUpdated: st.mtime.toISOString(),
            messageCount: 3,
            fileSizeBytes: st.size,
            previewMessages: [],
          });
        }
      }
      return out;
    },
    async findSession() {
      return null;
    },
    async loadSession(): Promise<MessageSummary[]> {
      return [];
    },
    getMessageContent(): string {
      return "";
    },
    getMessageRaw(): unknown {
      return null;
    },
    getMessagesContent(): string {
      return "";
    },
    autoTrimSuggestions(): number[] {
      return [];
    },
    summarizeContent(): MessageSummary[] {
      return [];
    },
    diffContent(): DiffEntry[] {
      return [];
    },
    async saveSession(): Promise<string> {
      return "";
    },
  };
}

// Stub TaskHandle for tests that don't care about cancellation.
function makeHandle(signal?: AbortSignal): TaskHandle {
  const controller = new AbortController();
  return {
    id: "test",
    signal: signal ?? controller.signal,
    reportProgress: vi.fn(),
    throwIfCancelled: () => {
      if ((signal ?? controller.signal).aborted) {
        throw new Error("cancelled");
      }
    },
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "search-test-"));
  _resetRegistryForTesting();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  _resetRegistryForTesting();
});

describe("searchSessions", () => {
  it("returns empty when no projects are registered", async () => {
    const results = await searchSessions("anything", makeHandle());
    expect(results).toEqual([]);
  });

  it("rejects queries shorter than 2 chars", async () => {
    registerProvider(
      makeFakeProvider("claude", tmpDir, "my-project", "/fake/root"),
    );
    await expect(searchSessions("a", makeHandle())).rejects.toThrow(
      /too short/i,
    );
  });

  it("finds literal matches across multiple JSONL files", async () => {
    const file1 = path.join(tmpDir, "session-a.jsonl");
    const file2 = path.join(tmpDir, "session-b.jsonl");
    await writeFile(
      file1,
      jsonl(
        {
          type: "user",
          uuid: "u1",
          message: { role: "user", content: "tell me about oscilla naga" },
        },
        {
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: "oscilla naga is a shim" },
        },
      ),
    );
    await writeFile(
      file2,
      jsonl({
        type: "user",
        uuid: "u2",
        message: { role: "user", content: "nothing relevant here" },
      }),
    );
    registerProvider(
      makeFakeProvider("claude", tmpDir, "my-project", "/fake/root"),
    );

    const results = await searchSessions("oscilla naga", makeHandle());

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(file1);
    expect(results[0].totalMatches).toBe(2);
    expect(results[0].matches).toHaveLength(2);
    expect(results[0].matchesTruncated).toBe(false);
  });

  it("sorts results by lastUpdated desc (most recent first)", async () => {
    // The test deliberately puts MORE matches in the OLDER file to prove
    // recency wins over match count — users find sessions by "when", not "how
    // much". [LAW:one-source-of-truth] The main process is the authority on
    // sort order; the renderer re-sorts with the same key during streaming.
    const oldFile = path.join(tmpDir, "old.jsonl");
    const newFile = path.join(tmpDir, "new.jsonl");
    await writeFile(
      oldFile,
      jsonl(
        ...Array.from({ length: 5 }, (_, i) => ({
          type: "user",
          uuid: `o${i}`,
          message: { role: "user", content: "needle x5" },
        })),
      ),
    );
    await writeFile(
      newFile,
      jsonl({
        type: "user",
        uuid: "n",
        message: { role: "user", content: "needle once" },
      }),
    );
    // Explicit mtimes: old = 2024, new = 2025.
    const oldTs = new Date("2024-01-01T00:00:00Z");
    const newTs = new Date("2025-06-01T00:00:00Z");
    await utimes(oldFile, oldTs, oldTs);
    await utimes(newFile, newTs, newTs);
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("needle", makeHandle());

    expect(results).toHaveLength(2);
    expect(results[0].filePath).toBe(newFile);
    expect(results[1].filePath).toBe(oldFile);
    // Confirm recency won over match count.
    expect(results[0].totalMatches).toBeLessThan(results[1].totalMatches);
  });

  it("caps per-session matches at MAX_MATCHES_PER_SESSION and flags truncation", async () => {
    const file = path.join(tmpDir, "huge.jsonl");
    // 30 matches on distinct lines, cap is 25
    await writeFile(
      file,
      jsonl(
        ...Array.from({ length: 30 }, (_, i) => ({
          type: "user",
          uuid: `m${i}`,
          message: { role: "user", content: `line ${i} needle here` },
        })),
      ),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("needle", makeHandle());

    expect(results).toHaveLength(1);
    expect(results[0].totalMatches).toBe(30);
    expect(results[0].matches.length).toBe(25);
    expect(results[0].matchesTruncated).toBe(true);
  });

  it("extracts correct match offsets for highlighting", async () => {
    const file = path.join(tmpDir, "offset.jsonl");
    // The searched string "findme" appears at a known location. Slicing
    // snippet[matchStart..matchEnd] must return exactly "findme".
    await writeFile(
      file,
      jsonl({
        type: "user",
        uuid: "o1",
        message: { role: "user", content: "prefix findme suffix" },
      }),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("findme", makeHandle());
    expect(results).toHaveLength(1);
    const m = results[0].matches[0];
    expect(m.snippet.slice(m.matchStart, m.matchEnd).toLowerCase()).toBe(
      "findme",
    );
  });

  it("attaches messageRole for Claude JSONL matches", async () => {
    const file = path.join(tmpDir, "roles.jsonl");
    await writeFile(
      file,
      jsonl(
        {
          type: "user",
          uuid: "u",
          message: { role: "user", content: "needle from user" },
        },
        {
          type: "assistant",
          uuid: "a",
          message: { role: "assistant", content: "needle from assistant" },
        },
      ),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("needle", makeHandle());
    expect(results[0].matches).toHaveLength(2);
    const roles = results[0].matches.map((m) => m.messageRole).sort();
    expect(roles).toEqual(["assistant", "user"]);
  });

  it("reports progress via the task handle", async () => {
    const file = path.join(tmpDir, "progress.jsonl");
    // Need enough matches to cross the PROGRESS_STRIDE (20) threshold at least once
    await writeFile(
      file,
      jsonl(
        ...Array.from({ length: 25 }, (_, i) => ({
          type: "user",
          uuid: `p${i}`,
          message: { role: "user", content: `line ${i} needle` },
        })),
      ),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const handle = makeHandle();
    await searchSessions("needle", handle);
    // Should fire at least the final summary call; with 25 matches crossing
    // the stride we expect 2+ invocations.
    expect(handle.reportProgress).toHaveBeenCalled();
  });

  it("aborts the ripgrep child when the signal is tripped", async () => {
    // Write enough content that rg has meaningful work — we abort immediately,
    // so the result should reject with a cancellation.
    for (let i = 0; i < 40; i++) {
      await writeFile(
        path.join(tmpDir, `s-${i}.jsonl`),
        jsonl(
          ...Array.from({ length: 100 }, (_, j) => ({
            type: "user",
            uuid: `${i}-${j}`,
            message: { role: "user", content: `some content needle ${j}` },
          })),
        ),
      );
    }
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const controller = new AbortController();
    const handle: TaskHandle = {
      id: "cancel-test",
      signal: controller.signal,
      reportProgress: vi.fn(),
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new Error("cancelled");
      },
    };

    const promise = searchSessions("needle", handle);
    // Abort on next microtask so the child has had a chance to start.
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toBeDefined();
  });

  it("returns empty (not an error) when query has no matches", async () => {
    const file = path.join(tmpDir, "nomatch.jsonl");
    await writeFile(
      file,
      jsonl({
        type: "user",
        uuid: "n",
        message: { role: "user", content: "nothing here" },
      }),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("zzzzzz-does-not-exist", makeHandle());
    expect(results).toEqual([]);
  });

  it("case-insensitive by default", async () => {
    const file = path.join(tmpDir, "case.jsonl");
    await writeFile(
      file,
      jsonl({
        type: "user",
        uuid: "c",
        message: { role: "user", content: "The NEEDLE is sharp" },
      }),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("needle", makeHandle());
    expect(results).toHaveLength(1);
    expect(results[0].totalMatches).toBe(1);
  });

  it("streams results in batches via the onBatch callback", async () => {
    const fileCount = 25;
    for (let i = 0; i < fileCount; i++) {
      await writeFile(
        path.join(tmpDir, `stream-${i}.jsonl`),
        jsonl({
          type: "user",
          uuid: `s${i}`,
          message: { role: "user", content: `stream-needle ${i}` },
        }),
      );
    }
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const batches: number[] = [];
    const collected: SessionSearchResult[] = [];
    const final = await searchSessions(
      "stream-needle",
      makeHandle(),
      (batch) => {
        batches.push(batch.length);
        collected.push(...batch);
      },
    );

    // Incremental emission proof: batches flushed before the promise resolved,
    // and every final-result appears in some batch.
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(collected).toHaveLength(final.length);
    expect(final).toHaveLength(fileCount);
  });

  it("excludes subagent jsonl files via glob filter", async () => {
    // Claude's adapter only surfaces top-level <project>/*.jsonl. rg must
    // share that definition — subagent files would otherwise inflate counts.
    const subagentsDir = path.join(tmpDir, "some-session-id", "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, "real.jsonl"),
      jsonl({
        type: "user",
        uuid: "r",
        message: { role: "user", content: "signal in real session" },
      }),
    );
    await writeFile(
      path.join(subagentsDir, "agent-abc.jsonl"),
      jsonl({
        type: "user",
        uuid: "a",
        message: { role: "user", content: "signal in subagent" },
      }),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("signal", makeHandle());
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(path.join(tmpDir, "real.jsonl"));
  });

  it("excludes backup files via glob filter", async () => {
    await writeFile(
      path.join(tmpDir, "live.jsonl"),
      jsonl({
        type: "user",
        uuid: "l",
        message: { role: "user", content: "foo in live" },
      }),
    );
    await writeFile(
      path.join(tmpDir, "live-backup.jsonl"),
      jsonl({
        type: "user",
        uuid: "b",
        message: { role: "user", content: "foo in backup" },
      }),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("foo", makeHandle());
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(path.join(tmpDir, "live.jsonl"));
  });

  it("treats the query as a literal, not a regex", async () => {
    // "a.b" shouldn't match "acb" — we use --fixed-strings. If someone regressed
    // this, the literal-dot match below would fail because the only content has
    // a literal dot.
    const file = path.join(tmpDir, "literal.jsonl");
    await writeFile(
      file,
      jsonl(
        {
          type: "user",
          uuid: "1",
          message: { role: "user", content: "literal a.b here" },
        },
        {
          type: "user",
          uuid: "2",
          message: { role: "user", content: "no dot: acb" },
        },
      ),
    );
    registerProvider(makeFakeProvider("claude", tmpDir, "p", "/fake/root"));

    const results = await searchSessions("a.b", makeHandle());
    expect(results).toHaveLength(1);
    expect(results[0].totalMatches).toBe(1);
  });
});
