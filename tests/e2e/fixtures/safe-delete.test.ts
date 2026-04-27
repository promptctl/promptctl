// @vitest-environment node
//
// Adversarial tests for assertSafeToDelete. Every refusal path must throw —
// not return — so a fixture bug becomes a loud test failure, never a silent
// rm of the developer's home.

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeToDelete } from "./safe-delete";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const target = cleanups.pop();
    if (target === undefined) continue;
    rmSync(target, { recursive: true, force: true });
  }
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

describe("assertSafeToDelete", () => {
  it("accepts a fresh promptctl-e2e- mkdtemp directory under tmpdir", () => {
    const dir = mkTemp("promptctl-e2e-accept-");
    expect(() => assertSafeToDelete("dir", dir)).not.toThrow();
  });

  it("returns silently for a path that does not exist (already cleaned)", () => {
    const dir = path.join(os.tmpdir(), "promptctl-e2e-nonexistent-xyz");
    expect(() => assertSafeToDelete("dir", dir)).not.toThrow();
  });

  it("refuses an empty path", () => {
    expect(() => assertSafeToDelete("dir", "")).toThrow(/empty/);
  });

  it("refuses the OS temp root itself", () => {
    expect(() => assertSafeToDelete("tempRoot", os.tmpdir())).toThrow(
      /not inside the OS temp root/,
    );
  });

  it("refuses a path outside tmpdir", () => {
    // Pick a directory we know exists and is outside tmpdir. The system root
    // works on every platform.
    expect(() => assertSafeToDelete("root", path.parse(process.cwd()).root)).toThrow(
      /not inside the OS temp root/,
    );
  });

  it("refuses the developer's real home directory", () => {
    expect(() =>
      assertSafeToDelete("home", os.homedir(), {
        // Even with the prefix-bypass-via-options pretend-tempdir, the
        // home-equality check fires first.
        _testTempRoot: path.parse(os.homedir()).root,
      }),
    ).toThrow(/resolves to or contains the user's home/);
  });

  it("refuses an ancestor of the developer's real home", () => {
    // Use the parent of homedir as the target. The check should reject because
    // the real home is inside it.
    const ancestor = path.dirname(os.homedir());
    expect(() =>
      assertSafeToDelete("ancestor", ancestor, {
        _testTempRoot: path.parse(ancestor).root,
      }),
    ).toThrow(/resolves to or contains the user's home/);
  });

  it("refuses a tmpdir-resident path WITHOUT the promptctl-e2e- prefix", () => {
    const dir = mkTemp("not-our-prefix-");
    expect(() => assertSafeToDelete("dir", dir)).toThrow(/does not start with/);
  });

  it("refuses a symlink whose target escapes tmpdir into home", () => {
    // Create a symlink under tmpdir with the right prefix that points at the
    // real home. realpath resolution must defeat this.
    const tmp = mkTemp("promptctl-e2e-symlink-parent-");
    const link = path.join(tmp, "promptctl-e2e-evil");
    symlinkSync(os.homedir(), link);

    expect(() => assertSafeToDelete("evilLink", link)).toThrow(
      // After realpath, the path is the real home → home check fires.
      // (On systems where /var/folders → /private/var/folders normalization
      // happens, the rel-to-tmpdir path also still resolves correctly.)
      /resolves to or contains the user's home|not inside the OS temp root/,
    );
  });

  it("refuses a symlink whose target is outside tmpdir but not home", () => {
    // Create an evil symlink to a non-home, non-tmp location.
    const tmp = mkTemp("promptctl-e2e-symlink-other-");
    const link = path.join(tmp, "promptctl-e2e-elsewhere");
    // /etc exists on every POSIX; on Windows fall back to system root.
    const target = process.platform === "win32" ? path.parse(process.cwd()).root : "/etc";
    symlinkSync(target, link);

    expect(() => assertSafeToDelete("evilLink", link)).toThrow(
      /not inside the OS temp root/,
    );
  });

  it("refuses a relative path that escapes via ..", () => {
    const tmp = mkTemp("promptctl-e2e-escape-base-");
    // Create a real subdirectory we'll dot-dot-out of.
    const sub = path.join(tmp, "promptctl-e2e-real-sub");
    mkdirSync(sub);
    const escape = path.join(sub, "..", "..");
    // The resolved real path is the parent of tmp (i.e., tmpdir itself), which
    // fails the "not the temp root" check or the prefix check, depending on
    // platform symlink normalization.
    expect(() => assertSafeToDelete("escape", escape)).toThrow(
      /not inside the OS temp root|does not start with/,
    );
  });
});
