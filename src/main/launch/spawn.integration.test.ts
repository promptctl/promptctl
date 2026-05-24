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
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnTmux, type TmuxTransport } from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import { TmuxControlConnection } from "../tmux/control";
import { TmuxTopologyTracker } from "../tmux/topology";
import { TmuxError, tmuxExec } from "../tmux/exec";
import {
  composeShellCommand,
  sessionExistsForTesting,
  spawnLaunch,
} from "./spawn";
import { LaunchRegistry, launchEnvBlock } from "./registry";
import { startLaunchCorrelator } from "./correlator";
import type { LaunchId, SessionId } from "../../shared/types";

const SEED_SESSION = "launch-seed";

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

describe("launch identity env propagation (real tmux mesh)", () => {
  let socket: string;

  beforeEach(() => {
    socket = uniqueSocket();
    // Seed a session so the mesh has something to attach to; the spawn
    // flow creates a different one via execute().
    execSync(tmuxCmd(socket, `new-session -d -s ${SEED_SESSION}`), {
      stdio: "ignore",
    });
  });

  afterEach(() => {
    killServer(socket);
  });

  it(
    "env vars from launchEnvBlock reach the launched process",
    { timeout: 15000 },
    async () => {
      const conn = TmuxControlConnection.start({
        socketPath: socket,
        ...meshDepsFor(socket),
        reconcileIntervalMs: 200,
      });
      await Promise.race([
        conn.ready,
        delay(8000).then(() => {
          throw new Error("control connection never reached ready");
        }),
      ]);

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

      await conn.execute(
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

      let panePid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const list = await conn.execute(
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

      await delay(150);
      const envText = readProcessEnv(panePid);
      expect(envText).toContain(`PROMPTCTL_LAUNCH_ID=${launchId}`);
      expect(envText).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:53991");
      expect(envText).toContain(
        `ANTHROPIC_CUSTOM_HEADERS=X-Promptctl-Launch: ${launchId}`,
      );
      expect(envText).toContain("PROMPTCTL_LAUNCH_TOOL=claude");

      await conn.execute(`kill-session -t ${tmuxEscape(TARGET_SESSION)}`);
    },
  );

  it(
    "sessionExists reports existing/missing sessions consistently",
    { timeout: 10000 },
    async () => {
      const conn = TmuxControlConnection.start({
        socketPath: socket,
        ...meshDepsFor(socket),
        reconcileIntervalMs: 200,
      });
      await conn.ready;

      const execute = (cmd: string) => conn.execute(cmd);
      // SEED_SESSION exists (we created it in beforeEach).
      expect(await sessionExistsForTesting(execute, SEED_SESSION)).toBe(true);
      expect(await sessionExistsForTesting(execute, `nope-${Date.now()}`)).toBe(
        false,
      );
    },
  );

  it(
    "topology populates after a launch-style new-session",
    { timeout: 10000 },
    async () => {
      const conn = TmuxControlConnection.start({
        socketPath: socket,
        ...meshDepsFor(socket),
        reconcileIntervalMs: 200,
      });
      await conn.ready;
      const topology = new TmuxTopologyTracker({
        onEvent: (event, handler) => conn.on(event, handler),
        onConnectionState: (listener) => conn.onConnectionState(listener),
        execute: (cmd) => conn.execute(cmd),
        subscribeRaw: (name, what, format) =>
          conn.subscribeRaw(name, what, format),
      });
      await waitFor(
        () => topology.snapshot().panes.length > 0,
        5000,
        "initial topology populated",
      );

      const TARGET = `topo-target-${Date.now()}`;
      await conn.execute(
        `new-session -d -s ${tmuxEscape(TARGET)} -c /tmp ${tmuxEscape("/bin/cat")}`,
      );
      await waitFor(
        () => topology.snapshot().panes.some((p) => p.sessionName === TARGET),
        5000,
        "new session shows in topology",
      );
      await conn.execute(`kill-session -t ${tmuxEscape(TARGET)}`);
      topology.dispose();
    },
  );

  it(
    // Empirically: under a wrapper-script binary (a zsh script that
    // forks a child without exec'ing), tmux's pane_current_command
    // reports the wrapper's shell ("zsh") rather than the launched tool,
    // and pane_pid stays at the wrapper's pid for the wrapper's entire
    // life. Under the prior shape, the correlator's toolKind-match
    // exit predicate would have phantom-killed the launch on the first
    // snapshot after markRunning. This test pins the new behavior:
    // spawnLaunch lands `running`, the correlator runs for ~500ms
    // observing the wrapped pane (toolKind == "unknown"), and the
    // launch remains `running`.
    "wrapped binary: launch reaches running and stays running",
    { timeout: 15000 },
    async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "promptctl-spawn-wrap-"));
      try {
        // Stub "binary" that mirrors the bug case: a shell script that
        // forks `sleep` as a child instead of exec'ing into it. tmux
        // sees the parent shell process and never the child. `/bin/sh`
        // is the most portable shebang — POSIX sh's fork-then-wait
        // semantics are the same as zsh's for this script shape, and
        // `/bin/sh` is present on every POSIX target (CI runners
        // included) without requiring zsh to be provisioned.
        const stubBinary = join(tmpRoot, "stub-wrapper");
        writeFileSync(
          stubBinary,
          // Use printf-and-wait pattern: the wrapper writes a marker
          // so we know it's alive, then forks sleep and waits.
          [
            "#!/bin/sh",
            "printf 'wrapper-started\\n'",
            "sleep 30 &",
            "wait $!",
            "",
          ].join("\n"),
        );
        chmodSync(stubBinary, 0o755);

        const conn = TmuxControlConnection.start({
          socketPath: socket,
          ...meshDepsFor(socket),
          reconcileIntervalMs: 200,
        });
        await conn.ready;

        // Spin up topology + correlator just like main.ts wires them.
        const topology = new TmuxTopologyTracker({
          onEvent: (event, handler) => conn.on(event, handler),
          onConnectionState: (listener) => conn.onConnectionState(listener),
          execute: (cmd) => conn.execute(cmd),
          subscribeRaw: (name, what, format) =>
            conn.subscribeRaw(name, what, format),
        });
        await waitFor(
          () => topology.snapshot().panes.length > 0,
          5000,
          "initial topology populated",
        );

        const registry = new LaunchRegistry({ save: async () => undefined });
        const disposeCorrelator = startLaunchCorrelator({
          registry,
          onTopologySnapshot: (listener) => topology.onSnapshot(listener),
          getTopologySnapshot: () => topology.snapshot(),
          onTmuxEvent: (event, handler) => conn.on(event, handler),
          onConnectionState: (listener) => conn.onConnectionState(listener),
        });

        const targetSession = `wrap-target-${Date.now()}`;
        const launch = await spawnLaunch(
          {
            registry,
            execute: (cmd) => conn.execute(cmd),
            getProxyPort: () => 53991,
            // The stub script stands in for the user's tool binary.
            toolBinaries: {
              claude: stubBinary,
              codex: stubBinary,
              gemini: stubBinary,
            },
            newLaunchId: () => "L-wrap" as LaunchId,
          },
          {
            toolKind: "claude",
            cwd: tmpRoot,
            sessionName: targetSession,
          },
        );
        expect(launch.status).toBe("running");
        expect(launch.launchId).toBe("L-wrap");

        // Wait for the wrapped pane to show up in the topology and for
        // pane_current_command to settle on the wrapper's shell name.
        // This is the snapshot edge that would have triggered the old
        // toolKind-match exit predicate.
        await waitFor(
          () =>
            topology
              .snapshot()
              .panes.some(
                (p) =>
                  p.sessionName === targetSession && p.toolKind === "unknown",
              ),
          5000,
          "wrapped pane visible with toolKind=unknown",
        );

        // Drive several reconcile passes by emitting topology refreshes
        // — anything that would have killed the launch under the old
        // predicate has fired by now.
        await delay(500);

        const after = registry.get(launch.launchId);
        expect(after?.status).toBe("running");

        disposeCorrelator();
        topology.dispose();
        await conn.execute(`kill-session -t ${tmuxEscape(targetSession)}`);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
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
