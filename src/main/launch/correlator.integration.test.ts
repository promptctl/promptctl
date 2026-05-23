// @vitest-environment node
//
// Integration test for the correlator's pid-from-topology binding
// against a real tmux server. Boots a control connection + topology +
// correlator, creates a registry row that points at a freshly spawned
// pane, and asserts the row's pid converges on the kernel's process id
// for that pane.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import { TmuxControlConnection } from "../tmux/control";
import { ensureSession } from "../tmux/session";
import { TmuxTopologyTracker } from "../tmux/topology";
import { LaunchRegistry } from "./registry";
import { startLaunchCorrelator } from "./correlator";
import type { LaunchId, PaneId, SessionId, WindowId } from "../../shared/types";

const OWNED = "promptctl-test-correlator";

function uniqueSocket(): string {
  return `promptctl-corr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socket: string, args: string): string {
  return `tmux -L ${socket} ${args}`;
}

function killServer(socket: string): void {
  try {
    execSync(tmuxCmd(socket, "kill-server"), { stdio: "ignore" });
  } catch {
    // Already dead.
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

describe("LaunchCorrelator (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
  });

  afterEach(() => {
    killServer(socket);
  });

  it(
    "binds a pane's real pid onto a running launch row",
    { timeout: 15000 },
    async () => {
      const conn = TmuxControlConnection.start({
        transportFactory: () =>
          spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
        sessionName: OWNED,
        bootstrap: () => ensureSession(OWNED, socket),
        reconnectDelayMs: 100,
      });
      await Promise.race([
        conn.ready,
        delay(8000).then(() => {
          throw new Error("control connection never reached ready");
        }),
      ]);
      const client = conn.client;
      if (!client) throw new Error("control client null after ready");

      const topology = new TmuxTopologyTracker({
        onEvent: (event, handler) => conn.on(event, handler),
        onConnectionState: (listener) => conn.onConnectionState(listener),
        getClient: () => conn.client,
      });
      await waitFor(
        () => topology.snapshot().panes.length > 0,
        5000,
        "initial topology populated",
      );

      const registry = new LaunchRegistry({ save: async () => undefined });
      startLaunchCorrelator({
        registry,
        onTopologySnapshot: (listener) => topology.onSnapshot(listener),
        getTopologySnapshot: () => topology.snapshot(),
        onTmuxEvent: (event, handler) => conn.on(event, handler),
        onConnectionState: (listener) => conn.onConnectionState(listener),
      });

      // Spawn a target session/pane the correlator will track.
      const TARGET = `corr-target-${Date.now()}`;
      await client.execute(
        `new-session -d -s ${tmuxEscape(TARGET)} -c /tmp ${tmuxEscape("/bin/cat")}`,
      );
      await waitFor(
        () => topology.snapshot().panes.some((p) => p.sessionName === TARGET),
        5000,
        "target pane visible in topology",
      );
      const targetPane = topology
        .snapshot()
        .panes.find((p) => p.sessionName === TARGET);
      if (!targetPane) throw new Error("target pane missing from snapshot");

      // Register a running launch whose paneId matches the spawned pane.
      registry.create({
        launchId: "corr-launch-1" as LaunchId,
        spec: { toolKind: "claude", cwd: "/tmp", sessionName: TARGET },
        paneId: targetPane.id as PaneId,
        sessionId: targetPane.sessionId as SessionId,
        windowId: targetPane.windowId as WindowId,
        env: {},
      });
      registry.markRunning("corr-launch-1" as LaunchId);

      // Wait for the correlator to attach the pane's pid onto the row.
      // The topology tracker has already delivered the pane in its
      // snapshot; the next snapshot cycle (or the initial replay) feeds
      // the correlator. Use waitFor instead of a hard sleep because
      // pane-pid arrives asynchronously after pane creation.
      await waitFor(
        () => {
          const row = registry.get("corr-launch-1" as LaunchId);
          return row?.status === "running" && row.pid !== null;
        },
        5000,
        "registry row gets a pid",
      );
      const row = registry.get("corr-launch-1" as LaunchId);
      if (row?.status === "running") {
        expect(row.pid).toBe(targetPane.pid);
      } else {
        throw new Error(`expected row to be running, got ${row?.status}`);
      }

      await client.execute(`kill-session -t ${tmuxEscape(TARGET)}`);
      topology.dispose();
    },
  );
});
