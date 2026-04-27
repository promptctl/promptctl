// [LAW:single-enforcer] All e2e tests acquire isolated tmux servers through
// this fixture. Each worker (and each test) gets a unique `-L <socket>` name;
// no test ever touches the developer's default tmux server.
//
// The shape mirrors src/main/tmux/control.integration.test.ts — same prefix
// scheme, same kill-on-teardown discipline. Different prefix
// ("promptctl-e2e-") so the two suites can run concurrently.

import { execFile, execSync } from "node:child_process";

export interface TmuxServerHandle {
  /** Socket name (passed as `-L <name>` to tmux). */
  readonly socket: string;
  /** Kill the tmux server backing this socket. */
  killServer(): void;
  /** Start a new detached session on this server. */
  newSession(name: string): void;
  /** Probe whether the server is currently up. */
  isAlive(): Promise<boolean>;
}

export function createTmuxServer(workerIndex: number): TmuxServerHandle {
  const socket = `promptctl-e2e-${process.pid}-${workerIndex}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  // Boot with one session so `has-session` succeeds on the first probe.
  execSync(`tmux -L ${socket} new-session -d -s bootstrap`, {
    stdio: "ignore",
  });

  function isAliveSync(): boolean {
    // execFileSync exits non-zero when no server is running on the socket.
    // We match the existing integration-test pattern (control.integration.test.ts)
    // but use the result to *gate* the kill instead of catching its failure —
    // failures from kill-server with a live server signal a real problem and
    // must not be swallowed.
    try {
      execSync(`tmux -L ${socket} has-session`, { stdio: "ignore" });
      return true;
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) {
        throw new Error(
          `tmux binary not found on PATH — required for e2e tests`,
        );
      }
      // Non-zero exit means no server (the documented failure mode). Any
      // other shape would have surfaced as ENOENT above; treat the rest as
      // "no server" to match tmux's behavior.
      return false;
    }
  }

  return {
    socket,
    killServer(): void {
      // [LAW:dataflow-not-control-flow] State-then-act: gate the kill on
      // server presence rather than swallow its failure. If the server is up
      // and kill-server still fails, that error is real and must propagate —
      // a leaked tmux process is a test-isolation hazard.
      if (!isAliveSync()) return;
      execSync(`tmux -L ${socket} kill-server`, { stdio: "ignore" });
    },
    newSession(name: string): void {
      execSync(`tmux -L ${socket} new-session -d -s ${name}`, {
        stdio: "ignore",
      });
    },
    isAlive(): Promise<boolean> {
      return new Promise((resolve, reject) => {
        execFile(
          "tmux",
          ["-L", socket, "has-session"],
          { timeout: 1000 },
          (err) => {
            if (err === null) {
              resolve(true);
              return;
            }
            if (isErrnoCode(err, "ENOENT")) {
              reject(
                new Error(
                  "tmux binary not found on PATH — required for e2e tests",
                ),
              );
              return;
            }
            // Non-zero exit means no server.
            resolve(false);
          },
        );
      });
    },
  };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
