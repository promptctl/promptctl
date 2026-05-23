// Unit tests for the launch correlator. The tmux event subscription
// is faked via in-memory dispatchers, so the registry mutations can be
// asserted deterministically without touching a real tmux server.

import { describe, expect, it } from "vitest";
import { startLaunchCorrelator } from "./correlator";
import { LaunchRegistry } from "./registry";
import type {
  LaunchId,
  PaneId,
  SessionId,
  TmuxPane,
  TmuxSnapshot,
  WindowId,
} from "../../shared/types";
import type { TmuxEventMap } from "tmux-control-mode-js";
import type { ConnectionStateEvent } from "../tmux/control";

const PANE: PaneId = "%17" as PaneId;
const SESS: SessionId = "$3" as SessionId;
const WIN: WindowId = "@5" as WindowId;

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: PANE,
    sessionName: "feature-x",
    sessionId: SESS,
    windowName: "w",
    windowId: WIN,
    windowIndex: 0,
    paneIndex: 0,
    pid: 1234,
    currentCommand: "claude",
    currentPath: "/repo",
    width: 80,
    height: 24,
    active: true,
    toolKind: "claude",
    ...overrides,
  };
}

function harness() {
  const registry = new LaunchRegistry({ save: async () => undefined });
  const snapshotListeners: ((s: TmuxSnapshot) => void)[] = [];
  const tmuxEventListeners = new Map<keyof TmuxEventMap, ((ev: unknown) => void)[]>();
  const connStateListeners: ((s: ConnectionStateEvent) => void)[] = [];
  let currentSnapshot: TmuxSnapshot = { timestamp: 0, panes: [] };
  const dispose = startLaunchCorrelator({
    registry,
    getTopologySnapshot: () => currentSnapshot,
    onTopologySnapshot: (listener) => {
      snapshotListeners.push(listener);
      return () => {
        const i = snapshotListeners.indexOf(listener);
        if (i >= 0) snapshotListeners.splice(i, 1);
      };
    },
    onTmuxEvent: (event, handler) => {
      const arr = tmuxEventListeners.get(event) ?? [];
      arr.push(handler as (ev: unknown) => void);
      tmuxEventListeners.set(event, arr);
      return () => {
        const a = tmuxEventListeners.get(event);
        if (!a) return;
        const i = a.indexOf(handler as (ev: unknown) => void);
        if (i >= 0) a.splice(i, 1);
      };
    },
    onConnectionState: (listener) => {
      connStateListeners.push(listener);
      return () => {
        const i = connStateListeners.indexOf(listener);
        if (i >= 0) connStateListeners.splice(i, 1);
      };
    },
  });
  return {
    registry,
    dispose,
    pushSnapshot(panes: TmuxPane[]) {
      const snapshot: TmuxSnapshot = { timestamp: Date.now(), panes };
      currentSnapshot = snapshot;
      for (const l of [...snapshotListeners]) l(snapshot);
    },
    setCurrentSnapshot(panes: TmuxPane[]) {
      currentSnapshot = { timestamp: Date.now(), panes };
    },
  };
}

function makeRunningLaunch(registry: LaunchRegistry): LaunchId {
  const created = registry.create({
    launchId: "L-1" as LaunchId,
    spec: { toolKind: "claude", cwd: "/repo", sessionName: "feature-x" },
    paneId: PANE,
    sessionId: SESS,
    windowId: WIN,
    env: {},
  });
  registry.markRunning(created.launchId);
  return created.launchId;
}

describe("LaunchCorrelator pid correlation", () => {
  it("attaches pid from the topology snapshot for running launches", () => {
    const h = harness();
    const id = makeRunningLaunch(h.registry);
    const initial = h.registry.get(id);
    if (initial?.status === "running") expect(initial.pid).toBeNull();
    h.pushSnapshot([makePane({ pid: 4242 })]);
    const after = h.registry.get(id);
    expect(after?.status).toBe("running");
    if (after?.status === "running") expect(after.pid).toBe(4242);
    h.dispose();
  });

  it("ignores panes that don't match any running launch", () => {
    const h = harness();
    const id = makeRunningLaunch(h.registry);
    h.pushSnapshot([
      makePane({ id: "%99" as PaneId, pid: 9999 }),
      makePane({ pid: 4242 }),
    ]);
    const after = h.registry.get(id);
    if (after?.status === "running") expect(after.pid).toBe(4242);
    h.dispose();
  });

  it("does not attach to pending or exited launches", () => {
    const h = harness();
    // Pending row — never markRunning.
    h.registry.create({
      launchId: "L-pending" as LaunchId,
      spec: { toolKind: "claude", cwd: "/repo", sessionName: "p" },
      paneId: PANE,
      sessionId: SESS,
      windowId: WIN,
      env: {},
    });
    // Exited row — created, run, exited.
    const created = h.registry.create({
      launchId: "L-exited" as LaunchId,
      spec: { toolKind: "claude", cwd: "/repo", sessionName: "e" },
      paneId: "%999" as PaneId,
      sessionId: SESS,
      windowId: WIN,
      env: {},
    });
    h.registry.markRunning(created.launchId);
    h.registry.markExited(created.launchId, "gone");

    h.pushSnapshot([
      makePane({ pid: 1234 }),
      makePane({ id: "%999" as PaneId, pid: 5678 }),
    ]);
    const pending = h.registry.get("L-pending" as LaunchId);
    expect(pending?.status).toBe("pending");
    // Exited row carries the pid forward from markExited, which was null —
    // the correlator does not retroactively patch it.
    const exited = h.registry.get("L-exited" as LaunchId);
    expect(exited?.status).toBe("exited");
    if (exited?.status === "exited") expect(exited.pid).toBeNull();
    h.dispose();
  });

  it("attaches pid from the current snapshot when a launch transitions to running after the snapshot arrived", () => {
    const h = harness();
    // Pre-load the snapshot with a pane that already has its pid.
    h.setCurrentSnapshot([makePane({ pid: 7777 })]);
    // Create + markRunning AFTER the snapshot — the registry-edge
    // trigger pulls the current snapshot and attaches.
    const id = makeRunningLaunch(h.registry);
    const after = h.registry.get(id);
    if (after?.status === "running") expect(after.pid).toBe(7777);
    h.dispose();
  });

  it("dispose stops all listeners", () => {
    const h = harness();
    const id = makeRunningLaunch(h.registry);
    h.dispose();
    h.pushSnapshot([makePane({ pid: 9999 })]);
    // After dispose, the snapshot pushes to no one — pid stays at the
    // value set by the last live snapshot (here: never set).
    const after = h.registry.get(id);
    if (after?.status === "running") expect(after.pid).toBeNull();
  });
});
