// Unit tests for SessionTailWatcher. Injected watchFile + getSize
// keep this hermetic; we don't trust fs.watch timing in CI. The
// watcher's contract: when any tracked file's reported size grows
// past the previous baseline, broadcast {filePath, size}; shrinks and
// no-ops produce no event.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionTailWatcher,
  type FileWatcher,
  type SessionTailEvent,
  type TailRegistryFacade,
  type WatchFileFn,
  type GetSizeFn,
} from "./tail-watcher";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";

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
    sessionFilePath: "/tmp/session.jsonl",
    ...overrides,
  };
}

interface FakeRegistry extends TailRegistryFacade {
  emit(event: LaunchEvent): void;
  set(launches: Launch[]): void;
}

function fakeRegistry(initial: Launch[] = []): FakeRegistry {
  let launches = [...initial];
  const listeners = new Set<(e: LaunchEvent) => void>();
  return {
    list: () => launches,
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit(event) {
      const idx = launches.findIndex(
        (l) => l.launchId === event.launch.launchId,
      );
      if (idx >= 0) launches = launches.map((l, i) => (i === idx ? event.launch : l));
      else launches = [...launches, event.launch];
      for (const h of listeners) h(event);
    },
    set(next) {
      launches = next;
    },
  };
}

function fakeFileWatcher() {
  const opened = new Map<string, () => void>();
  const closed: string[] = [];
  const watchFile: WatchFileFn = (filePath, onChange) => {
    opened.set(filePath, onChange);
    const w: FileWatcher = {
      close() {
        opened.delete(filePath);
        closed.push(filePath);
      },
    };
    return w;
  };
  return {
    watchFile,
    fire(filePath: string) {
      const h = opened.get(filePath);
      if (!h) throw new Error(`no watcher for ${filePath}`);
      h();
    },
    isOpen(filePath: string) {
      return opened.has(filePath);
    },
    closed,
  };
}

function sizeStubFrom(initial: Map<string, number>): {
  getSize: GetSizeFn;
  set(filePath: string, size: number): void;
} {
  const sizes = new Map(initial);
  return {
    getSize: async (filePath) => sizes.get(filePath) ?? null,
    set(filePath, size) {
      sizes.set(filePath, size);
    },
  };
}

// Drain microtasks + advance fake timers far enough for the debounce
// to fire. Vitest's fake timers don't fast-forward async chains
// automatically — we manually await between ticks.
async function flushAndTick(ms: number): Promise<void> {
  await Promise.resolve();
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("SessionTailWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Default runningLaunch fixture always supplies a sessionFilePath; pulled
  // into a const here so each test can refer to it without a non-null
  // assertion on every line.
  const FP = "/tmp/session.jsonl";

  it("broadcasts when a tracked file grows past its baseline", async () => {
    const launch = runningLaunch({ sessionFilePath: FP });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const sz = sizeStubFrom(new Map([[FP, 100]]));
    const events: SessionTailEvent[] = [];

    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: (e) => events.push(e),
      watchFile: fw.watchFile,
      getSize: sz.getSize,
      debounceMs: 25,
    });
    w.start();
    // Let probeBaseline land — it's an awaited stat we kicked off in
    // beginWatch. Microtask drain is enough; no timer involved.
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // File grew. Fire the event, advance past the debounce.
    sz.set(FP, 240);
    fw.fire(FP);
    await flushAndTick(25);

    expect(events).toEqual([{ filePath: FP, size: 240 }]);
    w.stop();
  });

  it("does not broadcast when the file shrinks (e.g. force-save truncate)", async () => {
    const launch = runningLaunch({ sessionFilePath: FP });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const sz = sizeStubFrom(new Map([[FP, 500]]));
    const events: SessionTailEvent[] = [];

    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: (e) => events.push(e),
      watchFile: fw.watchFile,
      getSize: sz.getSize,
      debounceMs: 10,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    sz.set(FP, 200); // truncated
    fw.fire(FP);
    await flushAndTick(10);

    expect(events).toEqual([]);

    // After the truncate the baseline tracks the new (smaller) size.
    // A subsequent grow past the NEW baseline must broadcast — the
    // watcher must not be permanently stuck at the old baseline.
    sz.set(FP, 350);
    fw.fire(FP);
    await flushAndTick(10);

    expect(events).toEqual([{ filePath: FP, size: 350 }]);
    w.stop();
  });

  it("coalesces a burst of events into one probe (debounce)", async () => {
    const launch = runningLaunch({ sessionFilePath: FP });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const sz = sizeStubFrom(new Map([[FP, 100]]));
    const events: SessionTailEvent[] = [];

    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: (e) => events.push(e),
      watchFile: fw.watchFile,
      getSize: sz.getSize,
      debounceMs: 50,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    sz.set(FP, 600);
    fw.fire(FP);
    fw.fire(FP);
    fw.fire(FP);
    await flushAndTick(50);

    expect(events.length).toBe(1);
    w.stop();
  });

  it("stops watching when a launch transitions to exited", async () => {
    const launch = runningLaunch({ sessionFilePath: FP });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const sz = sizeStubFrom(new Map([[FP, 0]]));

    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: () => undefined,
      watchFile: fw.watchFile,
      getSize: sz.getSize,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(fw.isOpen(FP)).toBe(true);

    const exited: Launch = {
      ...launch,
      status: "exited",
      exitedAt: 1_700_000_001_000,
      exitReason: "test",
    };
    reg.emit({ kind: "exited", launch: exited });

    expect(fw.isOpen(FP)).toBe(false);
    w.stop();
  });

  it("ignores launches with no sessionFilePath", async () => {
    const launch = runningLaunch({ sessionFilePath: null });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: () => undefined,
      watchFile: fw.watchFile,
      getSize: async () => 0,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // No file path → no watcher. The launch may later attach a path;
    // the registry's "updated" event will trigger reconcile() and
    // beginWatch() at that point.
    expect(fw.closed).toEqual([]);
    expect(fw.isOpen("/tmp/session.jsonl")).toBe(false);
    w.stop();
  });

  it("starts watching when a launch attaches a sessionFilePath after start()", async () => {
    const launch = runningLaunch({ sessionFilePath: null });
    const reg = fakeRegistry([launch]);
    const fw = fakeFileWatcher();
    const sz = sizeStubFrom(new Map());

    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: () => undefined,
      watchFile: fw.watchFile,
      getSize: sz.getSize,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(fw.isOpen("/tmp/session.jsonl")).toBe(false);

    const attached: LaunchRunning = {
      ...launch,
      sessionFilePath: "/tmp/session.jsonl",
    };
    reg.emit({ kind: "updated", launch: attached });

    expect(fw.isOpen("/tmp/session.jsonl")).toBe(true);
    w.stop();
  });

  it("stop() releases every watcher and unsubscribes from the registry", async () => {
    const a = runningLaunch({
      launchId: "a" as LaunchId,
      sessionFilePath: "/tmp/a.jsonl",
    });
    const b = runningLaunch({
      launchId: "b" as LaunchId,
      sessionFilePath: "/tmp/b.jsonl",
    });
    const reg = fakeRegistry([a, b]);
    const fw = fakeFileWatcher();
    const w = new SessionTailWatcher({
      registry: reg,
      broadcast: () => undefined,
      watchFile: fw.watchFile,
      getSize: async () => 0,
    });
    w.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(fw.isOpen("/tmp/a.jsonl")).toBe(true);
    expect(fw.isOpen("/tmp/b.jsonl")).toBe(true);

    w.stop();
    expect(fw.isOpen("/tmp/a.jsonl")).toBe(false);
    expect(fw.isOpen("/tmp/b.jsonl")).toBe(false);

    // Post-stop registry events must NOT cause new watchers to open.
    reg.emit({
      kind: "updated",
      launch: { ...a, sessionFilePath: "/tmp/a2.jsonl" },
    });
    expect(fw.isOpen("/tmp/a2.jsonl")).toBe(false);
  });
});
