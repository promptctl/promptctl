// Unit tests for the launch registry. No file I/O — the in-memory shape,
// transitions, events, and the persistence coalescer are exercised via
// injected fakes. Real-disk round-trips live in registry.integration.test.ts.

import { describe, expect, it } from "vitest";
import { LaunchRegistry, deterministicIdSequence, launchEnvBlock } from "./registry";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  LaunchPending,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";

const PANE: PaneId = "%17" as PaneId;
const SESS: SessionId = "$3" as SessionId;
const WIN: WindowId = "@5" as WindowId;

function makeRegistry() {
  const events: LaunchEvent[] = [];
  const saved: Launch[][] = [];
  const reg = new LaunchRegistry({
    save: async (rows) => {
      saved.push([...rows]);
    },
    now: () => 1_700_000_000_000,
    newId: deterministicIdSequence("launch"),
  });
  reg.on((e) => events.push(e));
  return { reg, events, saved };
}

function makeCreateInputs() {
  const env = launchEnvBlock({
    launchId: "launch-1" as LaunchId,
    proxyPort: 53991,
    toolKind: "claude",
  });
  return {
    spec: { toolKind: "claude" as const, cwd: "/repo/foo", sessionName: "feature-x" },
    paneId: PANE,
    sessionId: SESS,
    windowId: WIN,
    env,
  };
}

describe("LaunchRegistry.create", () => {
  it("returns a pending row stamped with the injected env", () => {
    const { reg } = makeRegistry();
    const row = reg.create(makeCreateInputs());
    expect(row.status).toBe("pending");
    expect(row.launchId).toBe("launch-1");
    expect(row.paneId).toBe(PANE);
    expect(row.sessionId).toBe(SESS);
    expect(row.windowId).toBe(WIN);
    expect(row.cwd).toBe("/repo/foo");
    expect(row.startedAt).toBe(1_700_000_000_000);
    expect(row.env.PROMPTCTL_LAUNCH_ID).toBe("launch-1");
    expect(row.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53991");
    expect(row.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Promptctl-Launch: launch-1");
    expect(row.env.PROMPTCTL_LAUNCH_TOOL).toBe("claude");
  });

  it("emits a created event with the same row", () => {
    const { reg, events } = makeRegistry();
    const row = reg.create(makeCreateInputs());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "created", launch: row });
  });
});

describe("LaunchRegistry.markRunning", () => {
  it("transitions pending → running and clears late-binding fields", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    const running = reg.markRunning(pending.launchId);
    expect(running?.status).toBe("running");
    expect(running?.pid).toBeNull();
    expect(running?.proxyClientId).toBeNull();
    expect(running?.sessionFilePath).toBeNull();
    expect(events.at(-1)).toMatchObject({ kind: "updated" });
  });

  it("is idempotent on an already-running row", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    reg.markRunning(pending.launchId);
    const beforeCount = events.length;
    const again = reg.markRunning(pending.launchId);
    expect(again?.status).toBe("running");
    expect(events).toHaveLength(beforeCount); // no extra event
  });

  it("refuses to revive an exited row", () => {
    const { reg } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    reg.markExited(pending.launchId, "tool exited");
    const result = reg.markRunning(pending.launchId);
    expect(result).toBeNull();
  });

  it("returns null for unknown ids", () => {
    const { reg } = makeRegistry();
    expect(reg.markRunning("nope" as LaunchId)).toBeNull();
  });
});

describe("LaunchRegistry.attach", () => {
  it("merges pid/clientId/sessionFile into a running row", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    reg.markRunning(pending.launchId);
    const next = reg.attach(pending.launchId, { pid: 1234, proxyClientId: "5678" });
    expect(next?.pid).toBe(1234);
    expect(next?.proxyClientId).toBe("5678");
    expect(next?.sessionFilePath).toBeNull();
    // Second attach: another late-binding field.
    const next2 = reg.attach(pending.launchId, { sessionFilePath: "/x/session.jsonl" });
    expect(next2?.pid).toBe(1234); // preserved
    expect(next2?.sessionFilePath).toBe("/x/session.jsonl");
    // Created + markRunning + 2 × attach = 4 events total.
    expect(events).toHaveLength(4);
  });

  it("does not emit when nothing changes", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    reg.markRunning(pending.launchId);
    reg.attach(pending.launchId, { pid: 1234 });
    const before = events.length;
    // Same pid arrives again from a duplicate subscription event.
    reg.attach(pending.launchId, { pid: 1234 });
    expect(events).toHaveLength(before);
  });

  it("rejects attach on pending and exited rows", () => {
    const { reg } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    expect(reg.attach(pending.launchId, { pid: 1 })).toBeNull();
    reg.markExited(pending.launchId, "x");
    expect(reg.attach(pending.launchId, { pid: 1 })).toBeNull();
  });
});

describe("LaunchRegistry.markExited", () => {
  it("transitions running → exited carrying late-binding fields forward", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    reg.markRunning(pending.launchId);
    reg.attach(pending.launchId, { pid: 999, proxyClientId: "abc" });
    const exited = reg.markExited(pending.launchId, "tool exited");
    expect(exited?.status).toBe("exited");
    if (exited?.status === "exited") {
      expect(exited.pid).toBe(999);
      expect(exited.proxyClientId).toBe("abc");
      expect(exited.exitReason).toBe("tool exited");
      expect(exited.exitedAt).toBe(1_700_000_000_000);
    }
    expect(events.at(-1)).toMatchObject({ kind: "exited" });
  });

  it("transitions pending → exited with null pid", () => {
    const { reg } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    const exited = reg.markExited(pending.launchId, "tool failed to start");
    expect(exited?.status).toBe("exited");
    if (exited?.status === "exited") {
      expect(exited.pid).toBeNull();
      expect(exited.exitReason).toBe("tool failed to start");
    }
  });

  it("is idempotent: second markExited returns the existing row", () => {
    const { reg, events } = makeRegistry();
    const pending = reg.create(makeCreateInputs());
    const first = reg.markExited(pending.launchId, "first");
    const before = events.length;
    const second = reg.markExited(pending.launchId, "second");
    expect(second).toEqual(first); // same row, same reason
    expect(events).toHaveLength(before); // no extra event
  });

  it("returns null for unknown ids", () => {
    const { reg } = makeRegistry();
    expect(reg.markExited("nope" as LaunchId, "x")).toBeNull();
  });
});

describe("LaunchRegistry lookups", () => {
  it("findByPane returns only non-exited launches", () => {
    const { reg } = makeRegistry();
    const a = reg.create(makeCreateInputs()) as LaunchPending;
    expect(reg.findByPane(PANE)?.launchId).toBe(a.launchId);
    reg.markExited(a.launchId, "gone");
    expect(reg.findByPane(PANE)).toBeNull();
  });

  it("findByWindow mirrors findByPane", () => {
    const { reg } = makeRegistry();
    const a = reg.create(makeCreateInputs()) as LaunchPending;
    expect(reg.findByWindow(WIN)?.launchId).toBe(a.launchId);
    reg.markExited(a.launchId, "gone");
    expect(reg.findByWindow(WIN)).toBeNull();
  });

  it("findByPid prefers the most recent running launch", () => {
    const { reg } = makeRegistry();
    const a = reg.create(makeCreateInputs());
    reg.markRunning(a.launchId);
    reg.attach(a.launchId, { pid: 100 });
    expect(reg.findByPid(100)?.launchId).toBe(a.launchId);
    expect(reg.findByPid(999)).toBeNull();
  });

  it("listActive excludes exited rows", () => {
    const { reg } = makeRegistry();
    const a = reg.create(makeCreateInputs());
    reg.markRunning(a.launchId);
    expect(reg.listActive()).toHaveLength(1);
    reg.markExited(a.launchId, "gone");
    expect(reg.listActive()).toHaveLength(0);
  });
});

describe("LaunchRegistry persistence", () => {
  it("persists every mutation through the injected save", async () => {
    const { reg, saved } = makeRegistry();
    const a = reg.create(makeCreateInputs());
    reg.markRunning(a.launchId);
    reg.attach(a.launchId, { pid: 42 });
    reg.markExited(a.launchId, "gone");
    await reg.__flushForTesting();
    // The coalescer batches concurrent saves — every mutation enqueues a
    // save, but multiple mutations within one tick may merge into one
    // write. The invariant is the final on-disk state matches the
    // in-memory state; assert that, not the number of writes.
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const last = saved.at(-1);
    expect(last?.[0].status).toBe("exited");
  });

  it("seeds from initial rows without emitting created events", () => {
    const events: LaunchEvent[] = [];
    const seed: Launch[] = [
      {
        launchId: "old" as LaunchId,
        toolKind: "claude",
        paneId: PANE,
        sessionId: SESS,
        windowId: WIN,
        cwd: "/x",
        startedAt: 1,
        env: {},
        status: "running",
        pid: 100,
        proxyClientId: null,
        sessionFilePath: null,
      },
    ];
    const reg = new LaunchRegistry({ initial: seed });
    reg.on((e) => events.push(e));
    expect(reg.list()).toEqual(seed);
    expect(events).toEqual([]);
  });

  it("persistence rejection is caught (no unhandled-promise crash)", async () => {
    // The save sink throws. The registry must catch it (so the
    // unhandled rejection doesn't crash main) and remain ready for the
    // next mutation to retry.
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    let saveCount = 0;
    try {
      const reg = new LaunchRegistry({
        save: async () => {
          saveCount += 1;
          throw new Error("disk full");
        },
      });
      reg.create({
        spec: { toolKind: "claude", cwd: "/x", sessionName: "a" },
        paneId: PANE,
        sessionId: SESS,
        windowId: WIN,
        env: {},
      });
      await reg.__flushForTesting();
      // First mutation persisted, save() rejected, we caught + logged.
      expect(saveCount).toBe(1);
      expect(errors.length).toBeGreaterThan(0);
      // Second mutation retries.
      reg.create({
        spec: { toolKind: "claude", cwd: "/y", sessionName: "b" },
        paneId: PANE,
        sessionId: SESS,
        windowId: WIN,
        env: {},
      });
      await reg.__flushForTesting();
      expect(saveCount).toBe(2);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("coalescer never piles up overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const reg = new LaunchRegistry({
      save: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      newId: deterministicIdSequence("L"),
    });
    // Burst of mutations.
    for (let i = 0; i < 20; i += 1) {
      const created = reg.create({
        spec: { toolKind: "claude", cwd: "/x", sessionName: `s${i}` },
        paneId: `%${i}` as PaneId,
        sessionId: SESS,
        windowId: WIN,
        env: {},
      });
      reg.markRunning(created.launchId);
    }
    await reg.__flushForTesting();
    expect(maxInFlight).toBe(1);
  });
});

describe("launchEnvBlock", () => {
  it("composes the three identity vars + tool kind", () => {
    const env = launchEnvBlock({
      launchId: "L" as LaunchId,
      proxyPort: 9000,
      toolKind: "codex",
    });
    expect(env).toEqual({
      PROMPTCTL_LAUNCH_ID: "L",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
      ANTHROPIC_CUSTOM_HEADERS: "X-Promptctl-Launch: L",
      PROMPTCTL_LAUNCH_TOOL: "codex",
    });
  });
});
