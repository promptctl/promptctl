// [LAW:single-enforcer] Sole reconciliation entrypoint for persisted
// launches at app start. Reads each non-exited row, asks the OS whether
// the original process is still our launched tool, and either keeps the
// row alive unchanged or marks it exited. We never re-attach pid here —
// the pid was already in the persisted row; verifying it's still ours
// is the entire job.
//
// [LAW:dataflow-not-control-flow] One walk over the registry's
// non-exited rows; each one runs the same pipeline (resolve pid →
// inspect env → keep-or-markExited). No "if this is a claude vs codex"
// branching — the identity check is the same.
//
// macOS reads env via `ps -E`. Linux reads `/proc/<pid>/environ`. The
// two paths converge on the same string match: PROMPTCTL_LAUNCH_ID=<id>.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { Launch, LaunchId } from "../../shared/types";
import type { LaunchRegistry } from "./registry";

const execFileP = promisify(execFile);

export interface RecoveryDeps {
  readonly registry: LaunchRegistry;
  // Test seam: override the env reader. Production wires `readEnv`.
  readonly readPidEnv?: (pid: number) => Promise<string | null>;
}

export interface RecoveryResult {
  readonly recovered: readonly Launch[];
  readonly exited: readonly Launch[];
}

export async function recoverLaunches(deps: RecoveryDeps): Promise<RecoveryResult> {
  const readPidEnv = deps.readPidEnv ?? readEnv;
  const candidates = deps.registry.listActive();
  const recovered: Launch[] = [];
  const exited: Launch[] = [];

  for (const launch of candidates) {
    if (launch.status === "exited") continue;
    if (launch.status === "pending") {
      // Persisted as pending — promptctl quit before the tool reached
      // the "running" transition. No pid to verify; treat as exited.
      const next = deps.registry.markExited(
        launch.launchId,
        "recovered as exited (never reached running)",
      );
      if (next) exited.push(next);
      continue;
    }
    if (launch.pid === null) {
      // running row without a pid (correlator never observed pane-pid
      // before persist) — same outcome as pending. Cannot reattach.
      const next = deps.registry.markExited(
        launch.launchId,
        "recovered as exited (no pid)",
      );
      if (next) exited.push(next);
      continue;
    }
    // [LAW:no-silent-fallbacks] readPidEnv returns null when the pid
    // is genuinely gone (ENOENT, process-not-found) and throws on
    // everything else (ps missing, permission denied, transient I/O
    // failure). A `.catch(() => null)` here would coerce every error
    // into "process gone" and incorrectly orphan still-running tools.
    // Real errors land in the catch below: we log loudly and leave
    // the launch row in its current state — the operator decides
    // whether to investigate or retry.
    let env: string | null;
    try {
      env = await readPidEnv(launch.pid);
    } catch (err) {
      console.error(
        `[launch] recovery: failed to read env for pid ${launch.pid} (launch ${launch.launchId}); leaving row alive:`,
        err,
      );
      recovered.push(launch);
      continue;
    }
    if (env === null) {
      const next = deps.registry.markExited(
        launch.launchId,
        "recovered as exited (process gone)",
      );
      if (next) exited.push(next);
      continue;
    }
    if (envContainsLaunchId(env, launch.launchId)) {
      // Same process, same identity — still alive.
      recovered.push(launch);
      continue;
    }
    // pid was reused by another program, or the launch's env was
    // rewritten — either way, our launch is gone.
    const next = deps.registry.markExited(
      launch.launchId,
      "recovered as exited (env mismatch)",
    );
    if (next) exited.push(next);
  }

  return { recovered, exited };
}

// Exported for unit tests.
//
// Matches PROMPTCTL_LAUNCH_ID=<launchId> as a whole-token: the launchId
// must be terminated by a boundary character (NUL, space, newline, or
// end-of-string). A substring match would false-positive on a different
// launchId that shares a prefix (e.g. `abc-123` matching `abc-123-x`).
//
// ps -E emits env as space-separated key=value on a single line;
// /proc/<pid>/environ separates entries with NULs; either format
// terminates each value at a NUL/space/newline.
export function envContainsLaunchId(env: string, launchId: LaunchId): boolean {
  const needle = `PROMPTCTL_LAUNCH_ID=${launchId}`;
  let idx = 0;
  while (idx <= env.length - needle.length) {
    const found = env.indexOf(needle, idx);
    if (found < 0) return false;
    const after = env.charCodeAt(found + needle.length);
    const isBoundary =
      Number.isNaN(after) || // end-of-string
      after === 0 || // NUL
      after === 32 || // space
      after === 10 || // LF
      after === 13; // CR
    if (isBoundary) return true;
    idx = found + 1;
  }
  return false;
}

export async function readEnv(pid: number): Promise<string | null> {
  // [LAW:dataflow-not-control-flow] The platform branches on the read
  // strategy, not the result — both return the same shape (env string
  // or null). Callers don't know which path ran.
  if (platform() === "linux") return readEnvLinux(pid);
  return readEnvMacos(pid);
}

async function readEnvLinux(pid: number): Promise<string | null> {
  try {
    // /proc/<pid>/environ is NUL-separated key=value entries.
    return await readFile(`/proc/${pid}/environ`, "utf-8");
  } catch (err) {
    if (isENOENT(err) || isEACCES(err)) return null;
    throw err;
  }
}

async function readEnvMacos(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP("ps", ["-E", "-p", String(pid), "-ww"], {
      timeout: 2000,
    });
    return stdout;
  } catch (err) {
    // ps exits 1 with no output when pid is missing — treat as null,
    // not an error. Other failures (permission, ps missing) propagate.
    if (isProcessGoneError(err)) return null;
    throw err;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function isEACCES(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "EACCES"
  );
}

function isProcessGoneError(err: unknown): boolean {
  // ps exits non-zero when the pid doesn't exist; execFile rejects.
  // The error has a `code` (process exit code) of 1 and no useful
  // stdout. Any other failure pattern is a real diagnostic.
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; killed?: unknown };
  return e.code === 1 && e.killed !== true;
}
