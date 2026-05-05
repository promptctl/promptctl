// @vitest-environment node
//
// Integration tests for TmuxTopologyTracker against a real tmux binary.
// Gated behind TMUX_INTEGRATION=1; mirrors the isolation pattern from
// control.integration.test.ts (unique `-L <socket>` per test, prefix
// `promptctl-tmux-topology-` so this suite can run alongside the others).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { ensureSession } from "./session";
import { TmuxTopologyTracker } from "./topology";
import type { TmuxSnapshot } from "../../shared/types";

const OWNED = "promptctl-test-topo";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(): string {
  return `promptctl-tmux-topology-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function tmuxCmd(socket: string, args: string): string {
  return `tmux -L ${socket} ${args}`;
}

function killServer(socket: string): void {
  try {
    execSync(tmuxCmd(socket, "kill-server"), { stdio: "ignore" });
  } catch {
    // Server may already be gone — the test fixture is the destructive
    // boundary, not us. Re-running kill-server on a dead server is the only
    // documented "this is fine" case for failure here.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    }
    await delay(20);
  }
}

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe.skipIf(!RUN_INTEGRATION)("TmuxTopologyTracker (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    // No initial session needed — bootstrap creates the owned one.

    // Outer test timeout sits above the largest inner waitFor budget so a
    // failure surfaces the descriptive "waitFor(<label>) timed out" error
    // instead of vitest's generic "Test timed out in 5000ms".
    vi.setConfig({ testTimeout: 10000 });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("seeds the snapshot from list-panes when the connection becomes ready", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });
    const tracker = new TmuxTopologyTracker({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
      ownedSessionName: () => conn.ownedSessionName,
    });

    const seen: TmuxSnapshot[] = [];
    tracker.onSnapshot((s) => {
      seen.push(s);
    });

    await conn.ready;
    await waitFor(
      () => (seen[seen.length - 1]?.panes.length ?? 0) >= 1,
      5000,
      "initial pane snapshot",
    );

    const snapshot = seen[seen.length - 1];
    expect(snapshot.panes.length).toBeGreaterThanOrEqual(1);
    // Every pane in the snapshot must belong to the owned session — the
    // tracker filters out anything else.
    expect(snapshot.panes.every((p) => p.sessionName === OWNED)).toBe(true);

    tracker.dispose();
    conn.close();
  });

  it("reflects a new pane within one event tick of tmux split-window", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });
    const tracker = new TmuxTopologyTracker({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
      ownedSessionName: () => conn.ownedSessionName,
    });

    await conn.ready;
    await waitFor(
      () => tracker.snapshot().panes.length >= 1,
      5000,
      "initial pane",
    );
    const before = tracker.snapshot().panes.length;

    execSync(tmuxCmd(socket, `split-window -t ${OWNED}`), { stdio: "ignore" });

    await waitFor(
      () => tracker.snapshot().panes.length === before + 1,
      // Well below the legacy 2s polling bound. Topology events arrive on
      // the control connection within milliseconds.
      1500,
      "split adds a pane",
    );

    tracker.dispose();
    conn.close();
  });

  it("ignores panes that belong to other sessions on the same server", async () => {
    // Pre-create a "user" session on the same server. This stands in for
    // the user's existing tmux work; promptctl must not surface its panes.
    execSync(tmuxCmd(socket, "new-session -d -s user-work"), {
      stdio: "ignore",
    });
    execSync(tmuxCmd(socket, "split-window -t user-work"), {
      stdio: "ignore",
    });

    const conn = TmuxControlConnection.start({
      transportFactory: () =>
        spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });
    const tracker = new TmuxTopologyTracker({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
      ownedSessionName: () => conn.ownedSessionName,
    });

    await conn.ready;
    await waitFor(
      () => tracker.snapshot().panes.length >= 1,
      5000,
      "owned session pane appears",
    );

    // Snapshot must contain ONLY owned-session panes — never user-work's.
    const snap = tracker.snapshot();
    expect(snap.panes.every((p) => p.sessionName === OWNED)).toBe(true);
    expect(snap.panes.some((p) => p.sessionName === "user-work")).toBe(false);

    tracker.dispose();
    conn.close();
  });

  it("removes a pane within one event tick of tmux kill-window", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });
    const tracker = new TmuxTopologyTracker({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
      ownedSessionName: () => conn.ownedSessionName,
    });

    await conn.ready;
    // Add a second window so we can kill it without taking the whole server
    // down.
    execSync(tmuxCmd(socket, `new-window -t ${OWNED}`), { stdio: "ignore" });
    await waitFor(
      () => tracker.snapshot().panes.length >= 2,
      5000,
      "second window appears",
    );
    const before = tracker.snapshot().panes.length;

    execSync(tmuxCmd(socket, `kill-window -t ${OWNED}:1`), { stdio: "ignore" });

    await waitFor(
      () => tracker.snapshot().panes.length === before - 1,
      1500,
      "kill-window removes a pane",
    );

    tracker.dispose();
    conn.close();
  });
});
