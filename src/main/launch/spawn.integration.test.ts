// @vitest-environment node
//
// Integration tests for the launch spawn path against a real tmux
// server. Two coverage goals:
//
//  1. The env block produced by `launchEnvBlock` + `composeShellCommand`,
//     piped through tmux's `new-session`, actually reaches the launched
//     process's environment. We exec `ps -E -p PID` to read the child's
//     env from the kernel.
//
//  2. `sessionExists` catches `%error can't find session` and reports
//     non-existence correctly — and reports existence when the session
//     does exist.
//
// We deliberately do NOT exercise the full `spawnLaunch` flow with a
// stub tool against real tmux: the pane-cmd subscription's tool-kind
// detection depends on the kernel's `comm` for the launched process,
// which is platform-specific (macOS vs Linux), shell-specific, and
// PATH-resolution-specific. The flow-level coverage lives in
// spawn.test.ts with a deterministic fake topology; the env-injection
// mechanism — which is the bit that actually crosses the process
// boundary — is what only real tmux can validate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import { TmuxControlConnection } from "../tmux/control";
import { ensureSession } from "../tmux/session";
import { TmuxTopologyTracker } from "../tmux/topology";
import { composeShellCommand, sessionExistsForTesting } from "./spawn";
import { launchEnvBlock } from "./registry";
import type { LaunchId } from "../../shared/types";

const OWNED = "promptctl-test-launch";

function uniqueSocket(): string {
  return `promptctl-launch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socket: string, args: string): string {
  return `tmux -L ${socket} ${args}`;
}

function killServer(socket: string): void {
  try {
    execSync(tmuxCmd(socket, "kill-server"), { stdio: "ignore" });
  } catch {
    // Already dead — the fixture is the destructive boundary, not us.
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

describe("launch identity env propagation (real tmux)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
  });

  afterEach(() => {
    killServer(socket);
  });

  it(
    "env vars from launchEnvBlock reach the launched process",
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

      const launchId = "test-launch-env-12345" as LaunchId;
      const env = launchEnvBlock({
        launchId,
        proxyPort: 53991,
        toolKind: "claude",
      });
      // `cat` reads from the pane's tty and waits — perfect for keeping
      // the child process alive so we can inspect its env via ps.
      const shellCommand = composeShellCommand(env, "/bin/cat");
      const TARGET_SESSION = `launch-env-target-${Date.now()}`;

      await client.execute(
        [
          "new-session",
          "-d",
          "-s",
          tmuxEscape(TARGET_SESSION),
          "-c",
          "/tmp",
          tmuxEscape(shellCommand),
        ].join(" "),
      );

      // tmux returns from new-session before the pane is fully populated
      // in some versions — give the kernel a beat to fork+exec the child
      // so list-panes returns a meaningful pid.
      let panePid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const list = await client.execute(
          `list-panes -t ${tmuxEscape(TARGET_SESSION)} -F "#{pane_pid}"`,
        );
        const candidate = Number(list.output[0]?.trim());
        if (Number.isFinite(candidate) && candidate > 0) {
          panePid = candidate;
          break;
        }
        await delay(50);
      }
      expect(panePid).toBeGreaterThan(0);

      // tmux's new-session is `sh -c <cmd>` → sh → env → cat. The pane's
      // foreground pid is whichever of those is currently running; by
      // the time we ask, env has exec'd into cat. Give the chain a beat
      // to settle, then read env. The pid we want may be panePid or a
      // child; pgrep -P traces children.
      await delay(150);
      const envText = readProcessEnv(panePid);
      expect(envText).toContain(`PROMPTCTL_LAUNCH_ID=${launchId}`);
      expect(envText).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:53991");
      expect(envText).toContain(
        `ANTHROPIC_CUSTOM_HEADERS=X-Promptctl-Launch: ${launchId}`,
      );
      expect(envText).toContain("PROMPTCTL_LAUNCH_TOOL=claude");

      await client.execute(`kill-session -t ${tmuxEscape(TARGET_SESSION)}`);
    },
  );

  it(
    "sessionExists reports existing/missing sessions consistently",
    { timeout: 10000 },
    async () => {
      const conn = TmuxControlConnection.start({
        transportFactory: () =>
          spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
        sessionName: OWNED,
        bootstrap: () => ensureSession(OWNED, socket),
        reconnectDelayMs: 100,
      });
      await conn.ready;
      const client = conn.client;
      if (!client) throw new Error("control client null after ready");

      // OWNED was bootstrapped — sessionExists should report true.
      expect(await sessionExistsForTesting(client, OWNED)).toBe(true);
      // A name that nobody created — should report false (the
      // "can't find session" reply is recognized and converted).
      expect(
        await sessionExistsForTesting(client, `nope-${Date.now()}`),
      ).toBe(false);
    },
  );

  it(
    "topology populates after a launch-style new-session",
    { timeout: 10000 },
    async () => {
      // Sanity: when we spawn a session via new-session, the topology
      // tracker sees it via window-add events. This is the wire we
      // depend on for waitForToolInPane in production.
      const conn = TmuxControlConnection.start({
        transportFactory: () =>
          spawnTmux(["attach-session", "-t", OWNED], { socketPath: socket }),
        sessionName: OWNED,
        bootstrap: () => ensureSession(OWNED, socket),
        reconnectDelayMs: 100,
      });
      await conn.ready;
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

      const TARGET = `topo-target-${Date.now()}`;
      const client = conn.client;
      if (!client) throw new Error("control client null after ready");
      await client.execute(
        `new-session -d -s ${tmuxEscape(TARGET)} -c /tmp ${tmuxEscape("/bin/cat")}`,
      );
      await waitFor(
        () => topology.snapshot().panes.some((p) => p.sessionName === TARGET),
        5000,
        "new session shows in topology",
      );
      await client.execute(`kill-session -t ${tmuxEscape(TARGET)}`);
      topology.dispose();
    },
  );
});

function readProcessEnv(pid: number): string {
  // Walk the pane process and its children — env propagated through the
  // chain (sh → env → cat), and the deepest is most likely to be the
  // long-lived one. On macOS `ps -E` shows env in the args column; on
  // Linux we can also read /proc/<pid>/environ but ps -E works there
  // for most distros.
  const seen = new Set<number>();
  const stack = [pid];
  const collected: string[] = [];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    try {
      const out = execSync(`ps -E -p ${next} -ww`).toString();
      collected.push(out);
    } catch {
      // Process might have exited mid-walk; try the rest.
    }
    try {
      const children = execSync(`pgrep -P ${next}`).toString().trim();
      if (children) {
        for (const line of children.split("\n")) {
          const child = Number(line.trim());
          if (Number.isFinite(child) && child > 0) stack.push(child);
        }
      }
    } catch {
      // pgrep returns exit code 1 when no children — that's "no rows",
      // not an error. We keep walking.
    }
  }
  return collected.join("\n");
}
