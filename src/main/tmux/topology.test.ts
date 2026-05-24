// @vitest-environment node
//
// Unit tests for TmuxTopologyTracker. The tracker is constructed with a fake
// TopologyDeps that captures every event handler and exposes hooks to fire
// canned events; the underlying TmuxClient is faked too. We never spawn a
// real tmux process here — the integration test (topology.integration.test.ts)
// covers that against a live server.
//
// Coverage focus per ticket 77e.1.3:
//   - Initial seed via list-panes after the ready transition.
//   - Per-field patches from subscription-changed events.
//   - Topology-event re-list (window-add / window-close / etc).
//   - Diff-gated broadcast (no broadcast when nothing changed).
//   - Connection-state transitions (closed clears the snapshot).

import { describe, expect, it, vi } from "vitest";
import type { TmuxEventMap } from "tmux-control-mode-js";
import type {
  CommandResponse,
  SubscriptionChangedMessage,
  WindowAddMessage,
  WindowCloseMessage,
} from "tmux-control-mode-js/protocol";
import { PANE_FORMAT } from "./pane-parse";
import type { ConnectionStateEvent } from "./control";
import { TmuxTopologyTracker, TOPOLOGY_SUBSCRIPTIONS } from "./topology";

// Local shape — TopologyClient was retired with the mesh refactor; the tracker
// now consumes execute() / subscribeRaw() directly via deps. Tests still
// instantiate a fake under this shape so assertions can read the call log.
interface FakeClient {
  executeCalls: string[];
  subscribeCalls: [string, string, string][];
  execute(command: string): Promise<CommandResponse>;
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;
}

interface Harness {
  tracker: TmuxTopologyTracker;
  fireConnState: (s: ConnectionStateEvent) => void;
  fireEvent: <K extends keyof TmuxEventMap>(
    event: K,
    payload: TmuxEventMap[K],
  ) => void;
  setListPanesResponse: (lines: string[]) => void;
  client: FakeClient;
  snapshots: ReturnType<TmuxTopologyTracker["snapshot"]>[];
}

const PANE_FORMAT_NEEDED = PANE_FORMAT; // re-export check

function paneLine(fields: {
  id?: string;
  sessionName?: string;
  sessionId?: string;
  windowName?: string;
  windowId?: string;
  windowIndex?: number;
  paneIndex?: number;
  pid?: number;
  currentCommand?: string;
  currentPath?: string;
  width?: number;
  height?: number;
  active?: boolean;
}): string {
  return [
    fields.id ?? "%1",
    fields.sessionName ?? "promptctl-test",
    fields.sessionId ?? "$0",
    fields.windowName ?? "shell",
    fields.windowId ?? "@0",
    fields.windowIndex ?? 0,
    fields.paneIndex ?? 0,
    fields.pid ?? 1234,
    fields.currentCommand ?? "zsh",
    fields.currentPath ?? "/home/user",
    fields.width ?? 80,
    fields.height ?? 24,
    fields.active ? 1 : 0,
  ].join("\t");
}

function makeHarness(): Harness {
  const eventHandlers = new Map<
    keyof TmuxEventMap,
    ((ev: unknown) => void)[]
  >();
  const stateListeners = new Set<(s: ConnectionStateEvent) => void>();
  let listPanesLines: string[] = [];

  const client: FakeClient = {
    executeCalls: [],
    subscribeCalls: [],
    async execute(command: string): Promise<CommandResponse> {
      client.executeCalls.push(command);
      return {
        commandNumber: client.executeCalls.length,
        timestamp: 0,
        output: listPanesLines,
        success: true,
      };
    },
    async subscribeRaw(
      name: string,
      what: string,
      format: string,
    ): Promise<CommandResponse> {
      client.subscribeCalls.push([name, what, format]);
      return {
        commandNumber: client.subscribeCalls.length,
        timestamp: 0,
        output: [],
        success: true,
      };
    },
  };

  const tracker = new TmuxTopologyTracker({
    onEvent<K extends keyof TmuxEventMap>(
      event: K,
      handler: (ev: TmuxEventMap[K]) => void,
    ): () => void {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler as (ev: unknown) => void);
      eventHandlers.set(event, list);
      return () => {
        const current = eventHandlers.get(event) ?? [];
        const idx = current.indexOf(handler as (ev: unknown) => void);
        if (idx >= 0) current.splice(idx, 1);
      };
    },
    onConnectionState(listener) {
      stateListeners.add(listener);
      // Mirror the real connection: fire current state synchronously.
      listener({
        status: "connecting",
        reconnectAttempts: 0,
        observedSessions: 0,
      });
      return () => stateListeners.delete(listener);
    },
    execute(command) {
      return client.execute(command);
    },
    subscribeRaw(name, what, format) {
      return client.subscribeRaw(name, what, format);
    },
  });

  const snapshots: ReturnType<TmuxTopologyTracker["snapshot"]>[] = [];
  tracker.onSnapshot((s) => snapshots.push(s));

  return {
    tracker,
    fireConnState(s) {
      for (const l of stateListeners) l(s);
    },
    fireEvent(event, payload) {
      const list = eventHandlers.get(event) ?? [];
      for (const h of list) h(payload as never);
    },
    setListPanesResponse(lines) {
      listPanesLines = lines;
    },
    client,
    snapshots,
  };
}

async function flush(): Promise<void> {
  // Drain through a macrotask boundary so every chained await in onReady →
  // safeAwait → subscribe / execute completes before the next assertion.
  // Each subscribe is itself a chain of ~3 microtasks; 7 subscriptions plus
  // the execute call would need careful counting otherwise. setImmediate
  // sidesteps that.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TmuxTopologyTracker", () => {
  it("exports the canonical PANE_FORMAT used by the legacy stack", () => {
    expect(PANE_FORMAT_NEEDED).toContain("#{pane_id}");
    expect(PANE_FORMAT_NEEDED).toContain("#{pane_pid}");
  });

  it("subscribes to every documented topology channel on ready", async () => {
    const h = makeHarness();
    h.setListPanesResponse([]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    const subscribed = new Set(h.client.subscribeCalls.map((c) => c[0]));
    for (const sub of TOPOLOGY_SUBSCRIPTIONS) {
      expect(subscribed.has(sub.name)).toBe(true);
    }
  });

  it("seeds the snapshot from list-panes output on ready", async () => {
    const h = makeHarness();
    h.setListPanesResponse([
      paneLine({ id: "%1", sessionName: "promptctl-test", windowName: "main" }),
      paneLine({
        id: "%2",
        sessionName: "promptctl-test",
        windowName: "main",
        currentCommand: "vim",
      }),
    ]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    const snap = h.tracker.snapshot();
    expect(snap.panes.map((p) => p.id)).toEqual(["%1", "%2"]);
    expect(snap.panes[1].currentCommand).toBe("vim");
    expect(snap.panes[1].toolKind).toBe("unknown");
  });

  it("patches a pane field from subscription-changed and broadcasts only on diff", async () => {
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1", currentCommand: "zsh" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    const broadcastsAfterSeed = h.snapshots.length;

    // Same value → no broadcast.
    h.fireEvent("subscription-changed", {
      type: "subscription-changed",
      name: "pane-cmd",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: 1,
      value: "zsh",
    } satisfies SubscriptionChangedMessage);
    expect(h.snapshots.length).toBe(broadcastsAfterSeed);

    // New value → broadcast + toolKind recomputed.
    h.fireEvent("subscription-changed", {
      type: "subscription-changed",
      name: "pane-cmd",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: 1,
      value: "claude",
    } satisfies SubscriptionChangedMessage);
    expect(h.snapshots.length).toBe(broadcastsAfterSeed + 1);
    expect(h.tracker.snapshot().panes[0].currentCommand).toBe("claude");
    expect(h.tracker.snapshot().panes[0].toolKind).toBe("claude");
  });

  it("ripples a window-name rename across every pane in the window", async () => {
    const h = makeHarness();
    h.setListPanesResponse([
      paneLine({ id: "%1", windowId: "@7", windowName: "old" }),
      paneLine({ id: "%2", windowId: "@7", windowName: "old" }),
      paneLine({ id: "%3", windowId: "@8", windowName: "other" }),
    ]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    h.fireEvent("subscription-changed", {
      type: "subscription-changed",
      name: "window-name",
      sessionId: -1,
      windowId: 7,
      windowIndex: -1,
      paneId: -1,
      value: "renamed",
    } satisfies SubscriptionChangedMessage);

    const panes = h.tracker.snapshot().panes;
    expect(panes.find((p) => p.id === "%1")?.windowName).toBe("renamed");
    expect(panes.find((p) => p.id === "%2")?.windowName).toBe("renamed");
    expect(panes.find((p) => p.id === "%3")?.windowName).toBe("other");
  });

  it("re-runs list-panes on a topology event and reflects the new pane", async () => {
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();
    expect(h.tracker.snapshot().panes).toHaveLength(1);

    h.setListPanesResponse([paneLine({ id: "%1" }), paneLine({ id: "%2" })]);
    h.fireEvent("window-add", {
      type: "window-add",
      windowId: 7,
    } satisfies WindowAddMessage);
    await flush();

    expect(h.tracker.snapshot().panes.map((p) => p.id)).toEqual(["%1", "%2"]);
  });

  it("clears the snapshot on a non-ready transition", async () => {
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();
    expect(h.tracker.snapshot().panes).toHaveLength(1);

    h.fireConnState({
      status: "closed",
      reason: "transport closed",
      reconnectAttempts: 1,
      observedSessions: 0,
    });

    expect(h.tracker.snapshot().panes).toHaveLength(0);
    // The closed transition should produce a broadcast carrying the empty
    // snapshot.
    expect(h.snapshots[h.snapshots.length - 1].panes).toHaveLength(0);
  });

  it("subscribes once and re-seeds the snapshot across a reconnect", async () => {
    // [LAW:single-enforcer] Re-subscription on transport churn is the
    // connection's job, not the tracker's. The tracker subscribes ONCE on
    // its first ready transition and trusts the connection's sticky
    // subscriptions to survive topology-source transfers. Re-seeding the
    // snapshot via list-panes still happens on every ready, because the
    // snapshot is the tracker's owned state — it has to refresh after a
    // gap during which tmux may have changed.
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();
    const subsAfterFirstReady = h.client.subscribeCalls.length;
    expect(subsAfterFirstReady).toBe(TOPOLOGY_SUBSCRIPTIONS.length);

    h.fireConnState({
      status: "closed",
      reason: "drop",
      reconnectAttempts: 1,
      observedSessions: 0,
    });
    h.setListPanesResponse([paneLine({ id: "%5" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 1,
      observedSessions: 1,
    });
    await flush();

    // Same number of subscriptions — no re-issue from the tracker.
    expect(h.client.subscribeCalls.length).toBe(subsAfterFirstReady);
    expect(h.tracker.snapshot().panes.map((p) => p.id)).toEqual(["%5"]);
  });

  it("ignores subscription-changed for an unknown pane (race with topology)", async () => {
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();
    const before = h.snapshots.length;

    h.fireEvent("subscription-changed", {
      type: "subscription-changed",
      name: "pane-cmd",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: 999,
      value: "vim",
    } satisfies SubscriptionChangedMessage);

    expect(h.snapshots.length).toBe(before);
    expect(h.tracker.snapshot().panes).toHaveLength(1);
  });

  it("removes a pane on window-close + list-panes refresh", async () => {
    const h = makeHarness();
    h.setListPanesResponse([
      paneLine({ id: "%1", windowId: "@0" }),
      paneLine({ id: "%2", windowId: "@1" }),
    ]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();
    expect(h.tracker.snapshot().panes).toHaveLength(2);

    h.setListPanesResponse([paneLine({ id: "%1", windowId: "@0" })]);
    h.fireEvent("window-close", {
      type: "window-close",
      windowId: 1,
    } satisfies WindowCloseMessage);
    await flush();

    expect(h.tracker.snapshot().panes.map((p) => p.id)).toEqual(["%1"]);
  });

  it("surfaces panes from every session on the connected tmux server", async () => {
    const h = makeHarness();
    h.setListPanesResponse([
      paneLine({ id: "%1", sessionName: "promptctl-test" }),
      paneLine({ id: "%2", sessionName: "work" }),
      paneLine({ id: "%3", sessionName: "promptctl-test" }),
      paneLine({ id: "%4", sessionName: "scratch" }),
    ]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    const ids = h.tracker.snapshot().panes.map((p) => p.id);
    expect(ids).toEqual(["%1", "%2", "%3", "%4"]);
  });

  it("dispose() removes all listeners and clears state", async () => {
    const h = makeHarness();
    h.setListPanesResponse([paneLine({ id: "%1" })]);
    h.fireConnState({
      status: "ready",
      reconnectAttempts: 0,
      observedSessions: 1,
    });
    await flush();

    const seen = vi.fn();
    h.tracker.onSnapshot(seen);
    seen.mockClear();
    h.tracker.dispose();

    h.fireEvent("subscription-changed", {
      type: "subscription-changed",
      name: "pane-cmd",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: 1,
      value: "vim",
    } satisfies SubscriptionChangedMessage);

    expect(seen).not.toHaveBeenCalled();
    expect(h.tracker.snapshot().panes).toHaveLength(0);
  });
});
