// @vitest-environment node
//
// Integration test for the per-session follower mesh added in 77e.3.7.
// Runs against a real tmux binary on an isolated `-L <socket>` server and
// asserts the end-to-end acceptance criterion of the ticket: live %output
// from panes in DIFFERENT tmux sessions reaches the connection's output
// handler simultaneously, instead of only the one session a singleton
// client happened to be attached to.
//
// This is the test that empirically distinguishes the new mesh shape from
// the prior single-attach world. If the mesh ever silently regresses to
// single-attach behavior, the assertion for `seenSessionB.length > 0`
// breaks and pinpoints the regression at the seam.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { TmuxControlConnection } from "./control";
import { TmuxTopologyTracker } from "./topology";
import { ensureSession } from "./session";
import type { SessionId, TmuxSnapshot } from "../../shared/types";

const OWNED = "promptctl-test";
const FOREIGN_A = "foreign-a";
const FOREIGN_B = "foreign-b";

function uniqueSocket(): string {
  return `promptctl-mesh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

// Read a session's id ($N) by name. Used to wire `observeSessions` with the
// real ids tmux assigned at session creation time.
function sessionIdByName(socket: string, name: string): SessionId {
  const out = execSync(
    tmuxCmd(socket, `list-sessions -F '#{session_name}:#{session_id}'`),
    { stdio: ["ignore", "pipe", "ignore"] },
  )
    .toString()
    .trim()
    .split("\n");
  for (const line of out) {
    const [n, id] = line.split(":");
    if (n === name && id !== undefined) return id as SessionId;
  }
  throw new Error(`session ${name} not found; lines=${JSON.stringify(out)}`);
}

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("multi-session follower mesh (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    // Three sessions: owned (primary attaches here) + two foreign that the
    // mesh should pick up via observeSessions.
    execSync(tmuxCmd(socket, `new-session -d -s ${OWNED}`), {
      stdio: "ignore",
    });
    execSync(tmuxCmd(socket, `new-session -d -s ${FOREIGN_A}`), {
      stdio: "ignore",
    });
    execSync(tmuxCmd(socket, `new-session -d -s ${FOREIGN_B}`), {
      stdio: "ignore",
    });
  });

  afterEach(() => {
    killServer(socket);
  });

  it("delivers %output from panes in every observed session simultaneously", async () => {
    const conn = TmuxControlConnection.start({
      transportFactory: (target) =>
        spawnTmux(["attach-session", "-t", target], { socketPath: socket }),
      sessionName: OWNED,
      bootstrap: () => ensureSession(OWNED, socket),
      reconnectDelayMs: 100,
    });

    await conn.ready;

    // Record every %output event the connection delivers, grouped by which
    // pane (and therefore which session) it came from.
    const outputs: { paneId: number; data: string }[] = [];
    conn.on("output", (ev) => {
      outputs.push({
        paneId: ev.paneId,
        data: new TextDecoder().decode(ev.data),
      });
    });
    conn.on("extended-output", (ev) => {
      outputs.push({
        paneId: ev.paneId,
        data: new TextDecoder().decode(ev.data),
      });
    });

    // Stand up the topology tracker against the same connection — production
    // wires `topology.onSnapshot → conn.observeSessions` so the mesh follows
    // the pane list. Replicate that wiring here so the test exercises the
    // real reconciliation path.
    const topology = new TmuxTopologyTracker({
      onEvent: (event, handler) => conn.on(event, handler),
      onConnectionState: (listener) => conn.onConnectionState(listener),
      getClient: () => conn.client,
    });

    // Mirror main.ts's filtering: the owned session is attached via primary,
    // so observation only contains foreign sessions. Without this filter,
    // a follower would spawn for the owned session and double-deliver
    // %output alongside the primary.
    let latestSnapshot: TmuxSnapshot | null = null;
    topology.onSnapshot((snap) => {
      latestSnapshot = snap;
      const sessions = new Set<SessionId>();
      for (const pane of snap.panes) {
        if (pane.sessionName === OWNED) continue;
        sessions.add(pane.sessionId);
      }
      conn.observeSessions(sessions);
    });

    // Wait for the snapshot to populate with panes from all three sessions.
    await waitFor(
      () => {
        if (latestSnapshot === null) return false;
        const ids = new Set(latestSnapshot.panes.map((p) => p.sessionName));
        return (
          ids.has(OWNED) && ids.has(FOREIGN_A) && ids.has(FOREIGN_B)
        );
      },
      5000,
      "topology snapshot to include all three sessions",
    );

    // The follower spawns are fire-and-forget — wait long enough for the
    // attach + setFlags round-trip to complete before driving traffic.
    await delay(300);

    // Inject distinctive output into a pane in EACH foreign session by
    // sending shell commands through the OWNED-session control client.
    // (send-keys is server-wide; the choice of which client issues the
    // command is irrelevant — what matters is which session the receiving
    // PANE belongs to, since that's what gates %output delivery.)
    const sidA = sessionIdByName(socket, FOREIGN_A);
    const sidB = sessionIdByName(socket, FOREIGN_B);

    const client = conn.client;
    if (client === null) throw new Error("primary client null after ready");
    // Target by session id: tmux routes to the session's active pane, which
    // for a freshly-created `new-session -d -s NAME` is the lone pane in
    // window 0. Avoids hard-coding window/pane indices that may shift.
    await client.execute(
      `send-keys -t '${sidA}' 'printf marker-from-A' Enter`,
    );
    await client.execute(
      `send-keys -t '${sidB}' 'printf marker-from-B' Enter`,
    );
    // Also drive the OWNED session — the primary's territory. If the mesh
    // wiring ever leaks the owned session into the observation set, a
    // duplicate follower would deliver this marker a second time and the
    // exactly-once assertion below would catch it.
    await client.execute(
      `send-keys -t '${OWNED}' 'printf marker-from-OWNED' Enter`,
    );

    // All three markers must appear; the foreign ones at least once, the
    // owned one EXACTLY once (would be twice if a follower also attached
    // to the owned session).
    await waitFor(
      () => {
        const blob = outputs.map((o) => o.data).join("");
        return (
          blob.includes("marker-from-A") &&
          blob.includes("marker-from-B") &&
          blob.includes("marker-from-OWNED")
        );
      },
      5000,
      "%output from all three sessions",
    );

    // Give a small grace window for any duplicate delivery to land — the
    // test would still pass on a single delivery but fail loud on two.
    await delay(150);

    const blob = outputs.map((o) => o.data).join("");
    expect(blob).toContain("marker-from-A");
    expect(blob).toContain("marker-from-B");

    const ownedOccurrences = (blob.match(/marker-from-OWNED/g) ?? []).length;
    expect(ownedOccurrences).toBe(1);
  });
});
