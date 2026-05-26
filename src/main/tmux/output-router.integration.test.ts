// @vitest-environment node
//
// Integration tests for TmuxOutputRouter against a real tmux binary,
// driven through the mesh-aware TmuxControlConnection. The router's
// shape is unchanged by the mesh refactor — it consumes execute() +
// setPaneAction() through the connection, which transparently routes
// to any ready client in the mesh.
//
// Isolation: unique `-L <socket>` per test, prefix `promptctl-tmux-output-`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux, type TmuxTransport } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { TmuxOutputRouter } from "./output-router";
import { TmuxError, tmuxExec } from "./exec";
import type {
  PaneId,
  SessionId,
  TmuxOutputChunk,
  TmuxOutputStateEvent,
} from "../../shared/types";
import type { WebContentsLike } from "./output-router";

const SEED_SESSION = "output-seed";

function uniqueSocket(): string {
  return `promptctl-tmux-output-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function tmuxCmd(socket: string, args: string): string {
  return `tmux -L ${socket} ${args}`;
}

// [LAW:single-enforcer] One decode site for the test side. Concatenating
// the raw chunks before decoding mirrors how a real consumer (xterm.js)
// accumulates the byte stream, so any chunk-boundary split of a multi-byte
// UTF-8 sequence still produces the correct text.
function joinChunks(chunks: readonly TmuxOutputChunk[]): string {
  let total = 0;
  for (const c of chunks) total += c.data.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c.data, off);
    off += c.data.byteLength;
  }
  return new TextDecoder("utf-8").decode(out);
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

function startMeshAndRouter(socket: string): {
  conn: TmuxControlConnection;
  router: TmuxOutputRouter;
} {
  const conn = TmuxControlConnection.start({
    socketPath: socket,
    ...meshDepsFor(socket),
    reconcileIntervalMs: 200,
  });
  const router = new TmuxOutputRouter({
    onEvent: (event, handler) => conn.on(event, handler),
    onConnectionState: (listener) => conn.onConnectionState(listener),
    execute: (cmd) => conn.execute(cmd),
    setPaneAction: (paneId, action) => conn.setPaneAction(paneId, action),
  });
  return { conn, router };
}

interface FakeWc {
  sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
  destroyListeners: Set<() => void>;
  send(channel: string, payload: unknown): void;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
  isDestroyed(): boolean;
}

function makeFakeWc(
  chunks: TmuxOutputChunk[],
  states: TmuxOutputStateEvent[],
): FakeWc {
  return {
    sent: [],
    destroyed: false,
    destroyListeners: new Set(),
    send(channel: string, payload: unknown) {
      this.sent.push({ channel, payload });
      if (channel === "tmux:output:chunk")
        chunks.push(payload as TmuxOutputChunk);
      if (channel === "tmux:output:state")
        states.push(payload as TmuxOutputStateEvent);
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
}

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxOutputRouter (real tmux mesh)", () => {
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

  it("receives output bytes from a pane running a command", async () => {
    const { conn, router } = startMeshAndRouter(socket);

    const chunks: TmuxOutputChunk[] = [];
    const states: TmuxOutputStateEvent[] = [];
    const fakeWc = makeFakeWc(chunks, states);

    await conn.ready;
    await delay(100);

    const listOutput = execSync(
      tmuxCmd(socket, `list-panes -t ${SEED_SESSION} -F "#{pane_id}"`),
      { encoding: "utf-8" },
    );
    const paneId = listOutput.trim().split("\n")[0] as PaneId;

    router.subscribe(paneId, fakeWc as unknown as WebContentsLike);

    await waitFor(
      () => chunks.length >= 1 || states.length >= 1,
      2000,
      "scrollback or streaming state",
    );

    execSync(
      tmuxCmd(
        socket,
        `send-keys -t ${paneId} 'printf "HELLO_ROUTER\\nLINE_TWO\\n"' Enter`,
      ),
    );

    await waitFor(
      () => joinChunks(chunks).includes("HELLO_ROUTER"),
      3000,
      "HELLO_ROUTER in output",
    );

    const allText = joinChunks(chunks);
    expect(allText).toContain("HELLO_ROUTER");
    expect(allText).toContain("LINE_TWO");
    expect(states.some((s) => s.state === "streaming")).toBe(true);

    router.dispose();
    conn.close();
  });

  it("delivers output from multiple sessions simultaneously through the mesh", async () => {
    // [LAW:one-type-per-behavior] The router doesn't care which session
    // a pane belongs to — every observed session is in the mesh and emits
    // %output the same way. This test asserts the "Done when" criterion
    // from ticket 77e.3.7: %output flows from both panes simultaneously
    // without any session being structurally privileged.
    execSync(tmuxCmd(socket, "new-session -d -s other-session"), {
      stdio: "ignore",
    });

    const { conn, router } = startMeshAndRouter(socket);

    const chunks: TmuxOutputChunk[] = [];
    const states: TmuxOutputStateEvent[] = [];
    const fakeWc = makeFakeWc(chunks, states);

    await conn.ready;
    await delay(100);

    const seedPaneId = execSync(
      tmuxCmd(socket, `list-panes -t ${SEED_SESSION} -F "#{pane_id}"`),
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")[0] as PaneId;
    const otherPaneId = execSync(
      tmuxCmd(socket, `list-panes -t other-session -F "#{pane_id}"`),
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")[0] as PaneId;

    router.subscribe(seedPaneId, fakeWc as unknown as WebContentsLike);
    router.subscribe(otherPaneId, fakeWc as unknown as WebContentsLike);
    await delay(200);
    chunks.length = 0;

    execSync(
      tmuxCmd(
        socket,
        `send-keys -t ${seedPaneId} 'printf "FROM_SEED\\n"' Enter`,
      ),
    );
    execSync(
      tmuxCmd(
        socket,
        `send-keys -t ${otherPaneId} 'printf "FROM_OTHER\\n"' Enter`,
      ),
    );

    await waitFor(
      () => {
        const text = joinChunks(chunks);
        return text.includes("FROM_SEED") && text.includes("FROM_OTHER");
      },
      3000,
      "output from both sessions",
    );

    router.dispose();
    conn.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const { conn, router } = startMeshAndRouter(socket);

    const chunks: TmuxOutputChunk[] = [];
    const states: TmuxOutputStateEvent[] = [];
    const fakeWc = makeFakeWc(chunks, states);

    await conn.ready;
    await delay(100);

    const listOutput = execSync(
      tmuxCmd(socket, `list-panes -t ${SEED_SESSION} -F "#{pane_id}"`),
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

    expect(chunks.length).toBe(chunkCountBefore);

    router.dispose();
    conn.close();
  });
});
