// [LAW:single-enforcer] One safety predicate for "is this path safe to rm -rf?"
// Any e2e fixture cleanup MUST gate destructive operations through this
// function. It cannot be bypassed by env-var changes mid-run because the
// trusted reference points (real home + real temp root) are captured at
// module-load time and stored in const bindings.
//
// [LAW:dataflow-not-control-flow] The predicate runs the same checks on every
// call — never short-circuits to "trust the caller." Same dataflow shape for
// fakeHome, userDataDir, or any future temp path.

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Captured ONCE at module load, before any test code can mutate process.env.
// Resolved through realpath so symlinked homes (common on macOS via
// /var → /private/var) are normalized to the same shape mkdtemp returns.
const REAL_HOME = realpathSync(os.homedir());
const TEMP_ROOT = realpathSync(os.tmpdir());
const REQUIRED_PREFIX = "promptctl-e2e-";

export interface SafeDeleteOptions {
  /** Override REAL_HOME — for tests of this predicate only. */
  readonly _testHome?: string;
  /** Override TEMP_ROOT — for tests of this predicate only. */
  readonly _testTempRoot?: string;
}

export function assertSafeToDelete(
  label: string,
  target: string,
  options: SafeDeleteOptions = {},
): void {
  const realHome = options._testHome ?? REAL_HOME;
  const tempRoot = options._testTempRoot ?? TEMP_ROOT;

  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`refuse to rm: ${label} is empty`);
  }

  // realpath resolution: rejects symlink-escapes from temp into home.
  // ENOENT is the one expected error — the path is gone, nothing to assert
  // (and rmSync with force:true will be a no-op anyway). Anything else is a
  // real failure (permission, I/O) and the caller deserves to see it.
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }

  // Must be a strict subdirectory of the OS temp root.
  const rel = path.relative(tempRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `refuse to rm: ${label}=${resolved} is not inside the OS temp root ${tempRoot}`,
    );
  }

  // Must not equal the developer's real home, nor be an ancestor of it.
  // (mkdtemp under tmpdir cannot produce such a path, but the check costs
  // nothing and converts hypothetical bugs into loud refusals.)
  if (resolved === realHome || realHome.startsWith(resolved + path.sep)) {
    throw new Error(
      `refuse to rm: ${label}=${resolved} resolves to or contains the user's home (${realHome})`,
    );
  }

  // Final shape check: the leaf must carry the prefix mkdtemp created with.
  // A path inside tmpdir but not created by our fixture is also refused.
  const base = path.basename(resolved);
  if (!base.startsWith(REQUIRED_PREFIX)) {
    throw new Error(
      `refuse to rm: ${label}=${resolved} basename ${base} does not start with ${REQUIRED_PREFIX}`,
    );
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
