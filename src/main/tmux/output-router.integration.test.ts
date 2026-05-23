// @vitest-environment node
//
// Integration tests for TmuxOutputRouter against a real tmux binary.
// Run unconditionally with the default `npm test` — tmux is a hard project
// requirement (README boundaries) and integration regressions must surface
// in the same loop as unit regressions, not behind an opt-in env var.
// Mirrors the isolation pattern from topology.integration.test.ts (unique
// `-L <socket>` per test).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { ensureSession } from "./session";
import { TmuxOutputRouter } from "./output-router";
import type { PaneId, TmuxOutputChunk, TmuxOutputStateEvent } from "../../shared/types";
import type { WebContentsLike } from "./output-router";

const OWNED = "promptctl-test-output";

function uniqueSocket(): string {
  return `promptctl-tmux-output-${Date.now()}-${Math.random()
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

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxOutputRouter (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();

    // Outer test timeout sits above the largest inner waitFor budget so a
    // failure surfaces the descriptive "waitFor(<label>) timed out" error
    // instead of vitest's generic "Test timed out in 5000ms".
    vi.setConfig({ testTimeout: 10000 });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("receives output bytes from a pane running a command", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: (target) =>
        spawnTmux(["attach-session", "-t", target], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });

    const router = new TmuxOutputRouter({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
    });

    const chunks: TmuxOutputChunk[] = [];
    const states: TmuxOutputStateEvent[] = [];

    // Minimal fake WebContents for the integration test.
    const fakeWc = {
      sent: [] as { channel: string; payload: unknown }[],
      destroyed: false,
      destroyListeners: new Set<() => void>(),
      send(channel: string, payload: unknown) {
        this.sent.push({ channel, payload });
        if (channel === "tmux:output:chunk") {
          chunks.push(payload as TmuxOutputChunk);
        }
        if (channel === "tmux:output:state") {
          states.push(payload as TmuxOutputStateEvent);
        }
      },
      once(_event: string, listener: () => void) {
        this.destroyListeners.add(listener);
      },
      removeListener(_event: string, listener: () => void) {
        this.destroyListeners.delete(listener);
      },
      isDestroyed() {
        return this.destroyed;
      },
    };

    await conn.ready;
    await delay(100);

    // Get the pane ID from the running session.
    const listOutput = execSync(
      tmuxCmd(socket, `list-panes -t ${OWNED} -F "#{pane_id}"`),
      { encoding: "utf-8" },
    );
    const paneId = listOutput.trim().split("\n")[0] as PaneId;

    router.subscribe(paneId, fakeWc as unknown as WebContentsLike);

    // Wait for scrollback capture.
    await waitFor(
      () => chunks.length >= 1 || states.length >= 1,
      2000,
      "scrollback or streaming state",
    );

    // Run a command that produces output.
    execSync(
      tmuxCmd(
        socket,
        `send-keys -t ${paneId} 'printf "HELLO_ROUTER\\nLINE_TWO\\n"' Enter`,
      ),
    );

    // Wait for the output to arrive.
    await waitFor(
      () => chunks.some((c) => c.data.includes("HELLO_ROUTER")),
      3000,
      "HELLO_ROUTER in output",
    );

    // At least the command output should have arrived.
    const allText = chunks.map((c) => c.data).join("");
    expect(allText).toContain("HELLO_ROUTER");
    expect(allText).toContain("LINE_TWO");

    // Streaming state should have been sent.
    expect(states.some((s) => s.state === "streaming")).toBe(true);

    router.dispose();
    conn.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: (target) =>
        spawnTmux(["attach-session", "-t", target], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });

    const router = new TmuxOutputRouter({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
    });

    const chunks: TmuxOutputChunk[] = [];
    const fakeWc = {
      sent: [] as { channel: string; payload: unknown }[],
      destroyed: false,
      destroyListeners: new Set<() => void>(),
      send(channel: string, payload: unknown) {
        this.sent.push({ channel, payload });
        if (channel === "tmux:output:chunk") {
          chunks.push(payload as TmuxOutputChunk);
        }
      },
      once(_event: string, listener: () => void) {
        this.destroyListeners.add(listener);
      },
      removeListener(_event: string, listener: () => void) {
        this.destroyListeners.delete(listener);
      },
      isDestroyed() {
        return this.destroyed;
      },
    };

    await conn.ready;
    await delay(100);

    const listOutput = execSync(
      tmuxCmd(socket, `list-panes -t ${OWNED} -F "#{pane_id}"`),
      { encoding: "utf-8" },
    );
    const paneId = listOutput.trim().split("\n")[0] as PaneId;

    router.subscribe(paneId, fakeWc as unknown as WebContentsLike);
    await waitFor(() => chunks.length >= 1, 2000, "scrollback");

    router.unsubscribe(paneId, fakeWc as unknown as WebContentsLike);
    const chunkCountBefore = chunks.length;

    execSync(
      tmuxCmd(socket, `send-keys -t ${paneId} 'echo AFTER_UNSUB' Enter`),
    );
    await delay(1000);

    // No new chunks should have arrived.
    expect(chunks.length).toBe(chunkCountBefore);

    router.dispose();
    conn.close();
  });
});
