// @vitest-environment node
//
// Integration tests for TmuxControlConnection's flat mesh against a real
// tmux binary. Run unconditionally with the default `npm test` — tmux is a
// hard project requirement (README boundaries) and integration regressions
// must surface in the same loop as unit regressions.
//
// Isolation: each test spawns its own tmux server on a unique `-L <socket>`
// name. The prefix `promptctl-tmux-control-` is distinct from the library's
// `tmux-js-test-` so the two suites can run concurrently without colliding,
// and neither touches the developer's default tmux server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux, type TmuxTransport } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { TmuxError, tmuxExec } from "./exec";
import type { SessionId } from "../../shared/types";

function uniqueSocket(): string {
  return `promptctl-tmux-control-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    await delay(50);
  }
}

// Returns the mesh-aware transport + enumeration deps for a given test
// socket. The connection discovers whatever sessions exist on the socket
// at startup and spawns a per-session client.
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

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxControlConnection mesh (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    // Outer timeout sits above the largest inner waitFor budget so a
    // failure surfaces a descriptive "waitFor(<label>) timed out" message
    // instead of vitest's generic "Test timed out in 5000ms".
    vi.setConfig({ testTimeout: 15000 });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("starts in no-sessions when the tmux server has no sessions yet", { timeout: 15000 }, async () => {
    // No new-session executed before connect — the server-less path is
    // the legitimate empty-mesh state.
    const conn = TmuxControlConnection.start({
      socketPath: socket,
      ...meshDepsFor(socket),
      reconcileIntervalMs: 5000,
    });

    await Promise.race([
      conn.ready,
      delay(5000).then(() => {
        throw new Error(
          `connection never reached ready; state=${JSON.stringify(conn.getState())}`,
        );
      }),
    ]);

    expect(conn.getState().status).toBe("no-sessions");
    expect(conn.getState().observedSessions).toBe(0);
  });

  it("discovers existing sessions at startup and reaches ready", { timeout: 15000 }, async () => {
    execSync(tmuxCmd(socket, "new-session -d -s alpha"), { stdio: "ignore" });
    execSync(tmuxCmd(socket, "new-session -d -s beta"), { stdio: "ignore" });

    const conn = TmuxControlConnection.start({
      socketPath: socket,
      ...meshDepsFor(socket),
      reconcileIntervalMs: 5000,
    });

    await Promise.race([
      conn.ready,
      delay(5000).then(() => {
        throw new Error(
          `connection never reached ready; state=${JSON.stringify(conn.getState())}`,
        );
      }),
    ]);

    expect(conn.getState().status).toBe("ready");
    expect(conn.getState().observedSessions).toBe(2);
  });

  it("survives a kill-server / restart cycle and returns to ready", { timeout: 15000 }, async () => {
    execSync(tmuxCmd(socket, "new-session -d -s probe"), { stdio: "ignore" });

    const conn = TmuxControlConnection.start({
      socketPath: socket,
      ...meshDepsFor(socket),
      reconcileIntervalMs: 100,
    });

    await conn.ready;
    expect(conn.getState().status).toBe("ready");

    killServer(socket);

    // The mesh empties out as transports drop. status goes to no-sessions.
    await waitFor(
      () => conn.getState().status === "no-sessions",
      3000,
      "transition to no-sessions after server kill",
    );

    // Bring the server back up. The periodic reconcile picks up the new
    // session, spawns a client for it, and the mesh recovers to ready.
    execSync(tmuxCmd(socket, "new-session -d -s recovery"), { stdio: "ignore" });

    await waitFor(
      () => conn.getState().status === "ready",
      5000,
      "reconnect after server restart",
    );

    expect(conn.getState().observedSessions).toBeGreaterThanOrEqual(1);
  });

  it("routes execute() through the mesh and works across reconnects", { timeout: 15000 }, async () => {
    execSync(tmuxCmd(socket, "new-session -d -s probe"), { stdio: "ignore" });

    const conn = TmuxControlConnection.start({
      socketPath: socket,
      ...meshDepsFor(socket),
      reconcileIntervalMs: 100,
    });

    await conn.ready;
    const r1 = await conn.execute("display-message -p 'pre-kill'");
    expect(r1.success).toBe(true);

    killServer(socket);
    await waitFor(
      () => conn.getState().status === "no-sessions",
      3000,
      "no-sessions after kill",
    );

    execSync(tmuxCmd(socket, "new-session -d -s recovery"), { stdio: "ignore" });
    await waitFor(
      () => conn.getState().status === "ready",
      5000,
      "ready after restart",
    );

    // Same connection handle; mesh now contains a different underlying
    // client. The execute() call routes through the new client transparently.
    const r2 = await conn.execute("display-message -p 'post-reconnect'");
    expect(r2.success).toBe(true);
  });
});
