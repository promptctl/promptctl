// @vitest-environment node
//
// Integration test for the recovery env-scan against the real OS. We
// spawn a child process with a known PROMPTCTL_LAUNCH_ID, ask the
// recovery module to read that pid's env, and assert the var appears.
// Then we kill the child and re-check that readEnv reports the pid is
// gone (null), which is the signal recoverLaunches uses to mark exited.

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readEnv, envContainsLaunchId } from "./recovery";
import type { LaunchId } from "../../shared/types";

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }
  children.length = 0;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("recovery.readEnv (real OS)", () => {
  it("reads PROMPTCTL_LAUNCH_ID from a live child process", async () => {
    const launchId = "recovery-test-launch-id-99" as LaunchId;
    const child = spawn("/bin/sleep", ["10"], {
      env: {
        ...process.env,
        PROMPTCTL_LAUNCH_ID: launchId,
      },
      detached: false,
    });
    children.push(child);
    expect(child.pid).toBeDefined();
    // Give the kernel a moment to populate the env table.
    await delay(50);
    const env = await readEnv(child.pid as number);
    expect(env).not.toBeNull();
    expect(envContainsLaunchId(env as string, launchId)).toBe(true);
  });

  it("returns null when the pid no longer exists", async () => {
    const child = spawn("/bin/sleep", ["0"], { detached: false });
    children.push(child);
    const pid = child.pid as number;
    // Wait for the process to actually exit. The pid table doesn't
    // recycle the entry instantly, but readEnv should see it as gone
    // once it's reaped.
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await delay(50);
    const env = await readEnv(pid);
    expect(env).toBeNull();
  });

  it("returns env without our var if the pid is some unrelated program", async () => {
    const child = spawn("/bin/sleep", ["10"], {
      env: { ...process.env, OTHER_VAR: "something" },
      detached: false,
    });
    children.push(child);
    await delay(50);
    const env = await readEnv(child.pid as number);
    expect(env).not.toBeNull();
    expect(envContainsLaunchId(env as string, "missing" as LaunchId)).toBe(
      false,
    );
  });
});
