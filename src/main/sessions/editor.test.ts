// Editor-coordinator unit tests. The validator integration tests in
// claude/validator.integration.test.ts cover the validation-blocked
// path end-to-end with a real adapter; this file isolates the
// live-tail guard and the lookup seam so we can assert behavior
// without the full Claude pipeline.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSession,
  saveSession,
  undo,
  redo,
  restoreVersion,
  compressToolResults,
  applyPipeline,
  setLiveTailLookup,
  LiveTailBlockedError,
  _resetForTesting,
} from "./editor";
import { registerProvider } from "./registry";
import { claudeAdapter } from "./claude/adapter";
import type { Pipeline } from "../../shared/types";

// A minimal valid Claude JSONL — one user line. Enough for the
// adapter to load, summarize, and not trip pre-save validation when
// nothing is removed.
const MIN_JSONL = `${JSON.stringify({
  type: "user",
  uuid: "u1",
  parentUuid: null,
  isSidechain: false,
  cwd: "/repo/foo",
  sessionId: "s",
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: "hi" },
})}\n`;

describe("editor.saveSession live-tail guard", () => {
  let dir: string;
  let fp: string;

  beforeEach(async () => {
    // Register the Claude adapter once — registerProvider is idempotent
    // by id, and the editor needs a real adapter so loadSession works.
    try {
      registerProvider(claudeAdapter);
    } catch {
      // already registered in a previous test
    }
    dir = path.join(
      tmpdir(),
      `pctl-editor-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(dir, { recursive: true });
    fp = path.join(dir, "session.jsonl");
    await writeFile(fp, MIN_JSONL, "utf-8");
  });

  afterEach(async () => {
    _resetForTesting();
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks save with blockedReason='live-tail' when the lookup returns a launch", async () => {
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await loadSession("claude", fp);

    const result = await saveSession([]);

    expect(result.blockedReason).toBe("live-tail");
    expect(result.path).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.forced).toBe(false);
  });

  it("does not consult the lookup when force=true", async () => {
    let lookupCalls = 0;
    setLiveTailLookup((p) => {
      lookupCalls += 1;
      return p === fp ? { launchId: "launch-xyz" } : null;
    });
    await loadSession("claude", fp);

    const result = await saveSession([], undefined, true);

    expect(result.blockedReason).toBeNull();
    expect(result.path).toBe(fp);
    // The save guard short-circuits the lookup entirely when force is
    // set — otherwise we'd be paying for the registry walk only to
    // ignore its result.
    expect(lookupCalls).toBe(0);
  });

  it("checks the destination path, not the active path, when outputPath is given", async () => {
    // Active file is live-tailed; destination is not. Save-as should
    // succeed because we're writing to a brand-new file no launch is
    // appending to.
    const altFp = path.join(dir, "alt.jsonl");
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await loadSession("claude", fp);

    const result = await saveSession([], altFp);

    expect(result.blockedReason).toBeNull();
    expect(result.path).toBe(altFp);
  });

  it("blocks when the destination IS live-tailed even if the active file is not", async () => {
    // Pathological but covered by the lens: the guard is about the
    // file we'd actually clobber, so it must consult the destination
    // regardless of what's currently loaded.
    const altFp = path.join(dir, "alt.jsonl");
    await writeFile(altFp, MIN_JSONL, "utf-8");
    setLiveTailLookup((p) =>
      p === altFp ? { launchId: "launch-xyz" } : null,
    );
    await loadSession("claude", fp);

    const result = await saveSession([], altFp);

    expect(result.blockedReason).toBe("live-tail");
    expect(result.path).toBeNull();
  });

  it("defaults to no-op lookup when setLiveTailLookup is never wired", async () => {
    // The editor's static module state has no registry by default.
    // saveSession must work fine in that state — used by tests, by
    // contexts without a registry, etc.
    await loadSession("claude", fp);
    const result = await saveSession([]);
    expect(result.blockedReason).toBeNull();
  });

  it("undo throws LiveTailBlockedError when the active file is live-tail", async () => {
    // undo writes the file in place — without the gate it would
    // truncate a launch's in-flight JSONL. Single helper, multiple
    // consumers: same gate as saveSession, different dispatch shape.
    await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await expect(undo()).rejects.toBeInstanceOf(LiveTailBlockedError);
  });

  it("redo throws LiveTailBlockedError when the active file is live-tail", async () => {
    await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await expect(redo()).rejects.toBeInstanceOf(LiveTailBlockedError);
  });

  it("restoreVersion throws LiveTailBlockedError when the active file is live-tail", async () => {
    await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await expect(restoreVersion(0)).rejects.toBeInstanceOf(
      LiveTailBlockedError,
    );
  });

  it("compressToolResults throws LiveTailBlockedError when the active file is live-tail", async () => {
    await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    await expect(
      compressToolResults(
        [],
        { summarizeThreshold: 1000, truncateThreshold: 500, keepLastN: 2 },
      ),
    ).rejects.toBeInstanceOf(LiveTailBlockedError);
  });

  it("applyPipeline blocks when the active file is live-tail (force=false)", async () => {
    await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    const pipeline: Pipeline = { steps: [] };
    const result = await applyPipeline(pipeline);
    expect(result.blockedReason).toBe("live-tail");
    expect(result.path).toBeNull();
  });

  it("applyPipeline with empty pipeline writes content unchanged and records a version", async () => {
    await loadSession("claude", fp);
    const result = await applyPipeline({ steps: [] });
    expect(result.blockedReason).toBeNull();
    expect(result.path).toBe(fp);
    expect(result.forced).toBe(false);
  });

  it("applyPipeline executes a remove-messages step end-to-end", async () => {
    // Two-user-message session; remove logical index 0 via the pipeline;
    // file on disk should have only u2 afterwards.
    const twoMsgJsonl =
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          isSidechain: false,
          cwd: "/r",
          sessionId: "s",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "first" },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          // No parentUuid → branch root, validator treats absence as fine.
          // Removing u1 thus doesn't orphan u2's reference.
          parentUuid: null,
          isSidechain: false,
          cwd: "/r",
          sessionId: "s",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "second" },
        }),
      ].join("\n") + "\n";
    await writeFile(fp, twoMsgJsonl, "utf-8");
    await loadSession("claude", fp);

    const pipeline: Pipeline = {
      steps: [
        {
          id: "step-1",
          source: "manual",
          kind: "remove-messages",
          targets: [0],
        },
      ],
    };
    const result = await applyPipeline(pipeline);
    expect(result.blockedReason).toBeNull();
    expect(result.forced).toBe(false);

    // Reload via loadSession so the messages reflect on-disk state.
    const messages = await loadSession("claude", fp);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("u2");
  });

  it("applyPipeline blocks on validation when output is structurally broken (force=false)", async () => {
    // Build a session with a tool_use/tool_result pair, then remove only
    // the user line containing the tool_result. The pipeline output has
    // an orphaned tool_use; the validator catches it.
    const session =
      [
        JSON.stringify({
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
            content: [{ type: "tool_use", id: "t1", name: "X", input: {} }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: "a1",
          isSidechain: false,
          cwd: "/r",
          sessionId: "s",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        }),
      ].join("\n") + "\n";
    await writeFile(fp, session, "utf-8");
    await loadSession("claude", fp);

    const pipeline: Pipeline = {
      steps: [
        {
          id: "s1",
          source: "manual",
          kind: "remove-messages",
          // Remove the user (logical index 1) — assistant tool_use becomes orphan.
          targets: [1],
        },
      ],
    };
    const result = await applyPipeline(pipeline);
    expect(result.blockedReason).toBe("validation");
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.path).toBeNull();
  });

  it("applyPipeline with force=true bypasses validation and writes forced=true", async () => {
    const session =
      [
        JSON.stringify({
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
            content: [{ type: "tool_use", id: "t1", name: "X", input: {} }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: "a1",
          isSidechain: false,
          cwd: "/r",
          sessionId: "s",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        }),
      ].join("\n") + "\n";
    await writeFile(fp, session, "utf-8");
    await loadSession("claude", fp);

    const pipeline: Pipeline = {
      steps: [
        {
          id: "s1",
          source: "manual",
          kind: "remove-messages",
          targets: [1],
        },
      ],
    };
    const result = await applyPipeline(pipeline, true);
    expect(result.blockedReason).toBeNull();
    expect(result.forced).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("loadSession behaves identically whether or not the file is live-tail (no branching outside the save guard)", async () => {
    // Acceptance criterion from 77e.5.6: "An 'adopted' file's
    // versioning, diff, compress, validate, and render paths share
    // their tests with the saved-file equivalents — same behavior
    // asserted by the same fixtures." Concrete check: load the same
    // file with and without a positive live-tail lookup; the parsed
    // message summaries must match exactly. If anything in the
    // load/parse path consults liveTailLookup, this would diverge.
    setLiveTailLookup(() => null);
    const messagesNonLive = await loadSession("claude", fp);
    setLiveTailLookup((p) =>
      p === fp ? { launchId: "launch-xyz" } : null,
    );
    const messagesLive = await loadSession("claude", fp);

    expect(messagesLive).toEqual(messagesNonLive);
  });
});
