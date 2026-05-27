// Unit tests for LaunchSessionWatcher. The narrow facade lets us run
// the matcher against a fake registry and an injected watch-dir
// without touching the real filesystem. A separate integration test
// in session-watcher.integration.test.ts exercises the default
// fs.watch wiring against a real tempdir.

import { mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LaunchSessionWatcher,
  encodeClaudeProjectDirName,
  type DirWatcher,
  type LaunchSessionRegistryFacade,
} from "./session-watcher";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";

// ─── Helpers ──────────────────────────────────────────────────────

function runningLaunch(overrides: Partial<LaunchRunning> = {}): LaunchRunning {
  return {
    launchId: "launch-1" as LaunchId,
    toolKind: "claude",
    paneId: "%1" as PaneId,
    sessionId: "$1" as SessionId,
    windowId: "@1" as WindowId,
    cwd: "/repo/foo",
    startedAt: 1_700_000_000_000,
    env: {},
    status: "running",
    pid: 1234,
    proxyClientId: null,
    sessionFilePath: null,
    ...overrides,
  };
}

interface FakeRegistry extends LaunchSessionRegistryFacade {
  emit(event: LaunchEvent): void;
  setLaunches(launches: Launch[]): void;
  attached: { launchId: LaunchId; sessionFilePath: string }[];
}

// Drains queued microtasks until `cond` returns true, or fails the
// test after `timeoutMs`. Used to wait for the watcher's fire-and-
// forget async chains (scanOnce → readdir → tryClaim → stat →
// attach) to settle before assertions. A fixed setImmediate count
// races under parallel test load — fs.stat can sit in the I/O queue
// longer than a handful of microtasks when CPU contention spikes.
async function waitFor(
  cond: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

// Brief drain for assertions that the watcher took NO action — there's
// nothing positive to wait for, so we just give the chain a few ticks
// to complete in case it would have. Used by "ignores stale file"
// tests where the absence of an attach is the assertion.
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function fakeRegistry(initial: Launch[] = []): FakeRegistry {
  let launches = [...initial];
  const listeners = new Set<(e: LaunchEvent) => void>();
  const attached: FakeRegistry["attached"] = [];
  return {
    list: () => launches,
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    attach(launchId, fields) {
      const idx = launches.findIndex((l) => l.launchId === launchId);
      if (idx < 0) return null;
      const cur = launches[idx];
      if (cur.status !== "running") return null;
      const next: LaunchRunning = {
        ...cur,
        sessionFilePath: fields.sessionFilePath,
      };
      launches = launches.map((l, i) => (i === idx ? next : l));
      attached.push({ launchId, sessionFilePath: fields.sessionFilePath });
      for (const h of listeners) h({ kind: "updated", launch: next });
      return next;
    },
    emit(event) {
      // emit() simulates an external registry mutation arriving — the
      // event listener fires but we also update our internal list so a
      // subsequent .list() sees the new state. Used to drive event-
      // arrival paths that aren't attach() (e.g. created, exited).
      const idx = launches.findIndex(
        (l) => l.launchId === event.launch.launchId,
      );
      if (idx >= 0) launches = launches.map((l, i) => (i === idx ? event.launch : l));
      else launches = [...launches, event.launch];
      for (const h of listeners) h(event);
    },
    setLaunches(next) {
      launches = next;
    },
    attached,
  };
}

// In-memory dir watcher: every call records the watched dir, lets the
// test fire synthetic file events. Mirrors the WatchDirFn signature
// the watcher consumes.
function memoryDirWatcher() {
  const opened = new Map<string, (filename: string) => void>();
  const closed: string[] = [];
  const watchDir = (
    dir: string,
    onChange: (filename: string) => void,
  ): DirWatcher => {
    opened.set(dir, onChange);
    return {
      close() {
        opened.delete(dir);
        closed.push(dir);
      },
    };
  };
  return {
    watchDir,
    fire(dir: string, filename: string) {
      const handler = opened.get(dir);
      if (!handler) throw new Error(`no watcher on ${dir}`);
      handler(filename);
    },
    isOpen(dir: string) {
      return opened.has(dir);
    },
    closed,
  };
}

// ─── Specs ────────────────────────────────────────────────────────

describe("encodeClaudeProjectDirName", () => {
  it("replaces / and . with -", () => {
    expect(encodeClaudeProjectDirName("/Users/bmf/code/promptctl")).toBe(
      "-Users-bmf-code-promptctl",
    );
    expect(
      encodeClaudeProjectDirName("/Users/bmf/code/promptctl/.claude"),
    ).toBe("-Users-bmf-code-promptctl--claude");
  });

  it("is purely substitution — does not collapse repeated separators", () => {
    expect(encodeClaudeProjectDirName("/a//b")).toBe("-a--b");
  });
});

describe("LaunchSessionWatcher (with injected fs)", () => {
  // Per-test tempdir is the simplest way to exercise the scan-on-start
  // path: we need real readdir+stat for the candidate file, even
  // though the watcher itself is driven through the in-memory
  // watchDir. The directory layout matches what Claude would create.
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `pctl-session-watcher-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJsonl(
    cwd: string,
    name: string,
    contents = '{"type":"system"}\n',
    mtimeMs?: number,
  ): Promise<string> {
    const dir = path.join(root, encodeClaudeProjectDirName(cwd));
    await mkdir(dir, { recursive: true });
    const fp = path.join(dir, name);
    await writeFile(fp, contents, "utf-8");
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000;
      await utimes(fp, t, t);
    }
    return fp;
  }

  it("attaches when a qualifying file is already on disk at start()", async () => {
    const launch = runningLaunch({ startedAt: 1_700_000_000_000 });
    const fp = await writeJsonl(
      launch.cwd,
      "abc.jsonl",
      "",
      1_700_000_001_000,
    );

    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await waitFor(() => reg.attached.length > 0);

    expect(reg.attached).toEqual([
      { launchId: launch.launchId, sessionFilePath: fp },
    ]);
    // After attach, the directory watcher is torn down — no point
    // keeping an fd open for a launch that's done.
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(launch.cwd))))
      .toBe(false);
    w.stop();
  });

  it("ignores files older than launch.startedAt (prior-run leftover)", async () => {
    const launch = runningLaunch({ startedAt: 1_700_000_010_000 });
    // Stale file from before the launch — exact same dir, mtime in
    // the past. The watcher must not latch onto it.
    await writeJsonl(
      launch.cwd,
      "old.jsonl",
      "",
      1_700_000_000_000,
    );

    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    expect(reg.attached).toEqual([]);
    // No qualifying file yet → watcher stays open for future events.
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(launch.cwd))))
      .toBe(true);
    w.stop();
  });

  it("latches the first .jsonl created after start() via the directory watcher", async () => {
    const launch = runningLaunch({ startedAt: 1_700_000_000_000 });
    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    const watchedDir = path.join(root, encodeClaudeProjectDirName(launch.cwd));
    expect(dw.isOpen(watchedDir)).toBe(true);

    // File appears after the watcher is up. Write the file, then fire
    // the synthetic event — matches the real-world ordering (event
    // fires once the data is on disk).
    const fp = await writeJsonl(
      launch.cwd,
      "new.jsonl",
      "",
      1_700_000_001_000,
    );
    dw.fire(watchedDir, "new.jsonl");
    await waitFor(() => reg.attached.length > 0);

    expect(reg.attached).toEqual([
      { launchId: launch.launchId, sessionFilePath: fp },
    ]);
    expect(dw.isOpen(watchedDir)).toBe(false);
    w.stop();
  });

  it("skips non-.jsonl filesystem events without attaching", async () => {
    const launch = runningLaunch({ startedAt: 1_700_000_000_000 });
    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    const watchedDir = path.join(root, encodeClaudeProjectDirName(launch.cwd));
    // Synthetic event for a sidecar file Claude sometimes drops. The
    // watcher must filter on extension; otherwise we'd attach the
    // wrong path and downstream save-guard would block the wrong file.
    await mkdir(watchedDir, { recursive: true });
    await writeFile(path.join(watchedDir, "snapshot.tmp"), "");
    dw.fire(watchedDir, "snapshot.tmp");
    await settle();

    expect(reg.attached).toEqual([]);
    expect(dw.isOpen(watchedDir)).toBe(true);
    w.stop();
  });

  it("ignores non-Claude launches outright (codex/gemini do not emit session JSONL)", async () => {
    const codex = runningLaunch({ toolKind: "codex" });
    const reg = fakeRegistry([codex]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    expect(reg.attached).toEqual([]);
    // No watcher opened for an unsupported tool kind.
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(codex.cwd))))
      .toBe(false);
    w.stop();
  });

  it("ignores launches whose sessionFilePath is already set", async () => {
    const launch = runningLaunch({ sessionFilePath: "/already/set.jsonl" });
    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    expect(reg.attached).toEqual([]);
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(launch.cwd))))
      .toBe(false);
    w.stop();
  });

  it("starts watching on a created event for a fresh launch", async () => {
    const reg = fakeRegistry([]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();

    const launch = runningLaunch({ launchId: "launch-late" as LaunchId });
    reg.emit({ kind: "created", launch });
    await settle();

    const dir = path.join(root, encodeClaudeProjectDirName(launch.cwd));
    expect(dw.isOpen(dir)).toBe(true);
    w.stop();
    expect(dw.isOpen(dir)).toBe(false);
  });

  it("stops watching when the launch transitions to exited", async () => {
    const launch = runningLaunch({ launchId: "launch-exit" as LaunchId });
    const reg = fakeRegistry([launch]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    const dir = path.join(root, encodeClaudeProjectDirName(launch.cwd));
    expect(dw.isOpen(dir)).toBe(true);

    const exited: Launch = {
      ...launch,
      status: "exited",
      exitedAt: 1_700_000_002_000,
      exitReason: "test",
    };
    reg.emit({ kind: "exited", launch: exited });

    expect(dw.isOpen(dir)).toBe(false);
    w.stop();
  });

  it("stop() closes every active watcher and detaches from the registry", async () => {
    const a = runningLaunch({
      launchId: "launch-a" as LaunchId,
      cwd: "/repo/a",
    });
    const b = runningLaunch({
      launchId: "launch-b" as LaunchId,
      cwd: "/repo/b",
    });
    const reg = fakeRegistry([a, b]);
    const dw = memoryDirWatcher();
    const w = new LaunchSessionWatcher({
      registry: reg,
      projectsRoot: root,
      watchDir: dw.watchDir,
    });
    w.start();
    await settle();

    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(a.cwd))))
      .toBe(true);
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(b.cwd))))
      .toBe(true);

    w.stop();

    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(a.cwd))))
      .toBe(false);
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(b.cwd))))
      .toBe(false);
    // After stop, further registry events MUST NOT cause new watchers
    // to open — start() reattached the listener; stop() removed it.
    reg.emit({
      kind: "updated",
      launch: { ...a, sessionFilePath: null },
    });
    expect(dw.isOpen(path.join(root, encodeClaudeProjectDirName(a.cwd))))
      .toBe(false);
  });
});
