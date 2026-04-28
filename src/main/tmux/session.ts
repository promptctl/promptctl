// [LAW:one-source-of-truth] Single derivation of the promptctl-owned tmux
// session name. The install root (e.g. app.getAppPath()) is the canonical
// input; the session name is a one-way hash of it. Two instances of the
// same install resolve to the same session and co-attach (tmux supports
// multiple control clients on one session); two different installs (dev +
// production, or two checkouts) get different names and do not collide.
//
// [LAW:single-enforcer] Every consumer (TmuxControlConnection bootstrap,
// topology tracker filter, future launch registry) reads ownedSessionName()
// rather than recomputing the hash.
//
// [LAW:dataflow-not-control-flow] The bootstrap command (`new-session -A
// -s <name> -d`) is idempotent by design. The same execution path runs
// regardless of whether the session already exists — tmux's -A flag does
// the dispatch, not our code.

import { createHash } from "node:crypto";
import { tmuxExec } from "./exec";

const SESSION_PREFIX = "promptctl-";

// Derives the deterministic session name from a stable install root. Take
// the root as a parameter so tests can pin it; production wires
// `app.getAppPath()` (or the equivalent) at the call site in main.ts.
export function ownedSessionName(installRoot: string): string {
  const hash = createHash("sha1").update(installRoot).digest("hex").slice(0, 8);
  return `${SESSION_PREFIX}${hash}`;
}

// True when a session name was produced by ownedSessionName(). Useful for
// future cleanup tools that want to identify orphans without ambiguity.
export function isOwnedSessionName(name: string): boolean {
  if (!name.startsWith(SESSION_PREFIX)) return false;
  const suffix = name.slice(SESSION_PREFIX.length);
  return /^[0-9a-f]{8}$/.test(suffix);
}

// Idempotent: creates the session if missing, no-ops if it already exists.
// Also boots the tmux server as a side effect of the first call. The `-d`
// flag prevents an actual attach — we just want the session to exist.
//
// Throws if the tmux binary is missing or any other error occurs. Callers
// surface that as a "closed" connection state rather than retrying blindly.
export async function ensureSession(
  name: string,
  socketPath: string | null,
): Promise<void> {
  // [LAW:dataflow-not-control-flow] socketPath is data on the args list;
  // the same exec path runs whether the env var is set or not.
  const socketArgs = socketPath === null ? [] : ["-L", socketPath];
  await tmuxExec([...socketArgs, "new-session", "-A", "-s", name, "-d"]);
}
