// @vitest-environment node
//
// Integration tests for TmuxTopologyTracker against a real tmux binary,
// driven through the mesh-aware TmuxControlConnection. Run unconditionally
// with the default `npm test`.
//
// Isolation: unique `-L <socket>` per test, prefix `promptctl-tmux-topology-`
// so this suite can run alongside the others without colliding with the
// developer's default tmux server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux, type TmuxTransport } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { TmuxTopologyTracker } from "./topology";
import { TmuxError, tmuxExec } from "./exec";
import type { SessionId, TmuxSnapshot } from "../../shared/types";

// Session names the tests create externally before booting the connection.
// The connection discovers them — there's no "owned" session here.
const SEED_SESSION = "topo-seed";

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
    // Server may already be gone.
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

function meshDepsFor(socket: string) {
  const transportFactory = (sessionId: SessionId): TmuxTransport =>
    spawnTmux(["attach-session", "-t", sessionId], { socketPath: socket });
  const enumerateSessions = async (): Promise<SessionId[]> => {
    try {
      const stdout = await tmuxExec([
        "-L",
        socket,
        "list-sessions",
        "-F",
        "#{session_id}",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line as SessionId);
    } catch (err) {
      if (
        err instanceof TmuxError &&
        /no server running|error connecting to/.test(err.stderr)
      ) {
        return [];
      }
      throw err;
    }
  };
  return { transportFactory, enumerateSessions };
}

function startMeshAndTracker(socket: string): {
  conn: TmuxControlConnection;
  tracker: TmuxTopologyTracker;
} {
  const conn = TmuxControlConnection.start({
    socketPath: socket,
    ...meshDepsFor(socket),
    reconcileIntervalMs: 200,
  });
  const tracker = new TmuxTopologyTracker({
    onEvent: (event, handler) => conn.on(event, handler),
    onConnectionState: (listener) => conn.onConnectionState(listener),
    execute: (cmd) => conn.execute(cmd),
    subscribeRaw: (name, what, format) => conn.subscribeRaw(name, what, format),
  });
  return { conn, tracker };
}

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxTopologyTracker (real tmux mesh)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    execSync(tmuxCmd(socket, `new-session -d -s ${SEED_SESSION}`), {
      stdio: "ignore",
    });
    vi.setConfig({ testTimeout: 10000 });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("seeds the snapshot from list-panes when the connection becomes ready", async () => {
    const { conn, tracker } = startMeshAndTracker(socket);
    const seen: TmuxSnapshot[] = [];
    tracker.onSnapshot((s) => seen.push(s));

    await conn.ready;
    await waitFor(
      () => (seen[seen.length - 1]?.panes.length ?? 0) >= 1,
      5000,
      "initial pane snapshot",
    );
    const last = seen[seen.length - 1];
    expect(last.panes.some((p) => p.sessionName === SEED_SESSION)).toBe(true);

    tracker.dispose();
    conn.close();
  });

  it("reflects a new pane within one event tick of tmux split-window", async () => {
    const { conn, tracker } = startMeshAndTracker(socket);

    await conn.ready;
    await waitFor(
      () => tracker.snapshot().panes.length >= 1,
      5000,
      "initial pane",
    );
    const before = tracker.snapshot().panes.length;

    execSync(tmuxCmd(socket, `split-window -t ${SEED_SESSION}`), {
      stdio: "ignore",
    });

    await waitFor(
      () => tracker.snapshot().panes.length === before + 1,
      1500,
      "split adds a pane",
    );

    tracker.dispose();
    conn.close();
  });

  it("surfaces panes from every observed session simultaneously", async () => {
    // Pre-create a second session before the connection boots — the mesh
    // must surface both, with neither structurally privileged.
    execSync(tmuxCmd(socket, "new-session -d -s user-work"), {
      stdio: "ignore",
    });
    execSync(tmuxCmd(socket, "split-window -t user-work"), {
      stdio: "ignore",
    });

    const { conn, tracker } = startMeshAndTracker(socket);

    await conn.ready;
    await waitFor(
      () => tracker.snapshot().panes.some((p) => p.sessionName === "user-work"),
      5000,
      "user-work panes appear in snapshot",
    );

    const snap = tracker.snapshot();
    expect(snap.panes.some((p) => p.sessionName === SEED_SESSION)).toBe(true);
    expect(
      snap.panes.filter((p) => p.sessionName === "user-work"),
    ).toHaveLength(2);

    tracker.dispose();
    conn.close();
  });

  it("removes a pane within one event tick of tmux kill-window", async () => {
    const { conn, tracker } = startMeshAndTracker(socket);

    await conn.ready;
    execSync(tmuxCmd(socket, `new-window -t ${SEED_SESSION}`), {
      stdio: "ignore",
    });
    await waitFor(
      () => tracker.snapshot().panes.length >= 2,
      5000,
      "second window appears",
    );
    const before = tracker.snapshot().panes.length;

    execSync(tmuxCmd(socket, `kill-window -t ${SEED_SESSION}:1`), {
      stdio: "ignore",
    });

    await waitFor(
      () => tracker.snapshot().panes.length === before - 1,
      1500,
      "kill-window removes a pane",
    );

    tracker.dispose();
    conn.close();
  });
});
