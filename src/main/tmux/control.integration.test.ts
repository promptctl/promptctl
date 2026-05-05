// @vitest-environment node
//
// Integration tests for TmuxControlConnection against a real tmux binary.
// Gated behind TMUX_INTEGRATION=1 so the default `npm test` run stays green
// on machines without tmux. Mirrors the gating + isolation pattern from
// ../tmux-control-mode-js/tests/integration/client.test.ts.
//
// Isolation: each test spawns its own tmux server on a unique `-L <socket>`
// name. The prefix `promptctl-tmux-control-` is distinct from the library's
// `tmux-js-test-` so the two suites can run concurrently without colliding,
// and neither touches the developer's default tmux server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { ensureSession } from "./session";

const OWNED = "promptctl-test";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

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

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe.skipIf(!RUN_INTEGRATION)("TmuxControlConnection (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    execSync(tmuxCmd(socket, "new-session -d -s probe"), { stdio: "ignore" });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("ensureSession is idempotent without a controlling terminal", async () => {
    // Regression: `tmux new-session -A -s NAME -d` falls back to attach-session
    // when the session exists, which tries to open /dev/tty and fails under
    // Electron with "open terminal failed: not a terminal". The reconnect loop
    // calls bootstrap() on every retry, so the second-and-onward calls must
    // succeed without a TTY. We force the no-TTY path by detaching stdio.
    await ensureSession(OWNED, socket); // first call: creates the session
    await ensureSession(OWNED, socket); // second call: must NOT try to attach

    const list = execSync(tmuxCmd(socket, "list-sessions -F '#{session_name}'"), {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split("\n");
    expect(list).toContain(OWNED);
  });

  it("connects to a real tmux server and reaches ready", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
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
  });

  it("survives a kill-server / restart cycle and returns to ready", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });

    await conn.ready;
    expect(conn.getState().status).toBe("ready");

    // Kill the server. The transport's onClose fires, which the connection
    // routes through handleClientFailure → setStatus("closed") → reconnect.
    killServer(socket);

    await waitFor(
      () => conn.getState().status === "closed",
      3000,
      "transition to closed after server kill",
    );

    // Bring the server back up. The next reconnect probe will succeed and the
    // connection should reach ready again without manual intervention.
    execSync(tmuxCmd(socket, "new-session -d -s recovery"), { stdio: "ignore" });

    await waitFor(
      () => conn.getState().status === "ready",
      5000,
      "reconnect after server restart",
    );

    expect(conn.getState().status).toBe("ready");
  });

  it("can issue commands through the new client after reconnect", async () => {
    // After a transport drop + reconnect, the connection's `client` accessor
    // must point at the new TmuxClient and that client must successfully
    // round-trip commands. This is the load-bearing property — any caller that
    // held a reference to the connection (not the raw client) keeps working
    // across reconnects without re-fetching.
    const conn = TmuxControlConnection.start({
      transportFactory: () => spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });

    await conn.ready;
    const before = conn.client;
    if (before === null) throw new Error("client null after ready");
    const r1 = await before.execute("display-message -p 'pre-kill'");
    expect(r1.success).toBe(true);

    killServer(socket);
    await waitFor(
      () => conn.getState().status === "closed",
      3000,
      "closed after kill",
    );

    execSync(tmuxCmd(socket, "new-session -d -s recovery"), { stdio: "ignore" });
    await waitFor(
      () => conn.getState().status === "ready",
      5000,
      "ready after restart",
    );

    const after = conn.client;
    if (after === null) throw new Error("client null after reconnect-ready");
    expect(after).not.toBe(before);
    const r2 = await after.execute("display-message -p 'post-reconnect'");
    expect(r2.success).toBe(true);
  });
});
