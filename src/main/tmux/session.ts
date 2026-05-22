// [LAW:one-source-of-truth] Single derivation of the promptctl-owned tmux
// session name. The install root (e.g. app.getAppPath()) is the canonical
// input; the session name is a one-way hash of it. Two instances of the
// same install resolve to the same session and co-attach (tmux supports
// multiple control clients on one session); two different installs (dev +
// production, or two checkouts) get different names and do not collide.
//
// [LAW:single-enforcer] Every consumer (TmuxControlConnection bootstrap,
// future launch registry) reads ownedSessionName() rather than recomputing
// the hash.

import { createHash } from "node:crypto";
import { TmuxError, tmuxExec } from "./exec";

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
// We do NOT use `tmux new-session -A` for idempotency. Despite its docs,
// `-A` falls back to attach-session behavior when the target session
// exists, and attach-session unconditionally opens /dev/tty for terminal
// capabilities — even with `-d`. Electron's main process has no
// controlling terminal, so the second-and-subsequent calls fail with
// "open terminal failed: not a terminal" and the reconnect loop spins.
// `has-session` + `new-session -d` both work without a TTY.
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
  // `=name` is an exact-match target (no prefix/glob match), so a session
  // called `promptctl-aea76698` doesn't accidentally satisfy a probe for
  // `promptctl-a` etc.
  if (await sessionExists([...socketArgs, "has-session", "-t", `=${name}`])) {
    return;
  }
  await tmuxExec([...socketArgs, "new-session", "-d", "-s", name]);
}

async function sessionExists(args: string[]): Promise<boolean> {
  try {
    await tmuxExec(args);
    return true;
  } catch (err) {
    // Two flavors of "not present yet" — both mean "go ahead and create":
    //   1. Server is running, session is missing  -> "can't find session"
    //   2. Server isn't running yet (fresh socket) -> "error connecting to ..."
    //      or "no server running on ..."
    // Anything else (binary missing, permission error, etc.) propagates so
    // the bootstrap surfaces a real diagnostic instead of silently retrying.
    if (
      err instanceof TmuxError &&
      /can't find session|no server running|error connecting to/.test(err.stderr)
    ) {
      return false;
    }
    throw err;
  }
}
