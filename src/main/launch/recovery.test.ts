// Unit tests for the launch recovery flow. Process env is injected via
// a fake `readPidEnv` so the tests are platform-independent and don't
// depend on ps / /proc.

import { describe, expect, it } from "vitest";
import { LaunchRegistry } from "./registry";
import { envContainsLaunchId, recoverLaunches } from "./recovery";
import type {
  Launch,
  LaunchId,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";

const PANE: PaneId = "%17" as PaneId;
const SESS: SessionId = "$3" as SessionId;
const WIN: WindowId = "@5" as WindowId;

function row(
  overrides: {
    launchId: LaunchId;
    status: Launch["status"];
    pid?: number | null;
  },
): Launch {
  const base = {
    launchId: overrides.launchId,
    toolKind: "claude" as const,
    paneId: PANE,
    sessionId: SESS,
    windowId: WIN,
    cwd: "/repo",
    startedAt: 1,
    env: { PROMPTCTL_LAUNCH_ID: overrides.launchId },
  };
  if (overrides.status === "pending") return { ...base, status: "pending" };
  if (overrides.status === "running") {
    return {
      ...base,
      status: "running",
      pid: overrides.pid ?? null,
      proxyClientId: null,
      sessionFilePath: null,
    };
  }
  return {
    ...base,
    status: "exited",
    pid: overrides.pid ?? null,
    proxyClientId: null,
    sessionFilePath: null,
    exitedAt: 2,
    exitReason: "test",
  };
}

function makeRegistry(initial: Launch[]): LaunchRegistry {
  return new LaunchRegistry({ initial, save: async () => undefined });
}

describe("envContainsLaunchId", () => {
  it("matches a key=value substring", () => {
    expect(
      envContainsLaunchId(
        "TERM=xterm\0PROMPTCTL_LAUNCH_ID=abc-123\0PATH=/usr/bin",
        "abc-123" as LaunchId,
      ),
    ).toBe(true);
  });

  it("does not match a different launchId that shares a prefix", () => {
    expect(
      envContainsLaunchId("PROMPTCTL_LAUNCH_ID=abc-123-extended", "abc-123" as LaunchId),
    ).toBe(false);
  });

  it("returns false when the var is absent", () => {
    expect(envContainsLaunchId("FOO=bar\0BAZ=qux", "anything" as LaunchId)).toBe(false);
  });
});

describe("recoverLaunches", () => {
  it("keeps a running row whose pid still owns the env", async () => {
    const reg = makeRegistry([
      row({ launchId: "live" as LaunchId, status: "running", pid: 100 }),
    ]);
    const result = await recoverLaunches({
      registry: reg,
      readPidEnv: async (pid) =>
        pid === 100 ? "PROMPTCTL_LAUNCH_ID=live\0PATH=/usr/bin" : null,
    });
    expect(result.recovered).toHaveLength(1);
    expect(result.exited).toHaveLength(0);
    expect(reg.get("live" as LaunchId)?.status).toBe("running");
  });

  it("marks exited when pid is gone (readPidEnv returns null)", async () => {
    const reg = makeRegistry([
      row({ launchId: "dead" as LaunchId, status: "running", pid: 200 }),
    ]);
    const result = await recoverLaunches({
      registry: reg,
      readPidEnv: async () => null,
    });
    expect(result.exited).toHaveLength(1);
    const final = reg.get("dead" as LaunchId);
    expect(final?.status).toBe("exited");
    if (final?.status === "exited") {
      expect(final.exitReason).toContain("process gone");
    }
  });

  it("marks exited when pid is reused by a different program", async () => {
    const reg = makeRegistry([
      row({ launchId: "stale" as LaunchId, status: "running", pid: 300 }),
    ]);
    const result = await recoverLaunches({
      registry: reg,
      // Same pid is alive, but env doesn't mention our launchId.
      readPidEnv: async () => "TERM=xterm\0PATH=/usr/bin",
    });
    expect(result.exited).toHaveLength(1);
    const final = reg.get("stale" as LaunchId);
    if (final?.status === "exited") {
      expect(final.exitReason).toContain("env mismatch");
    }
  });

  it("marks exited when a running row has no pid recorded", async () => {
    const reg = makeRegistry([
      row({ launchId: "no-pid" as LaunchId, status: "running", pid: null }),
    ]);
    let calls = 0;
    await recoverLaunches({
      registry: reg,
      readPidEnv: async () => {
        calls += 1;
        return null;
      },
    });
    expect(calls).toBe(0); // never asked the OS — we have nothing to ask about
    const final = reg.get("no-pid" as LaunchId);
    expect(final?.status).toBe("exited");
    if (final?.status === "exited") {
      expect(final.exitReason).toContain("no pid");
    }
  });

  it("marks pending rows exited (they never reached running)", async () => {
    const reg = makeRegistry([
      row({ launchId: "p" as LaunchId, status: "pending" }),
    ]);
    await recoverLaunches({
      registry: reg,
      readPidEnv: async () => null,
    });
    const final = reg.get("p" as LaunchId);
    expect(final?.status).toBe("exited");
    if (final?.status === "exited") {
      expect(final.exitReason).toContain("never reached running");
    }
  });

  it("leaves exited rows alone", async () => {
    const reg = makeRegistry([
      row({ launchId: "old" as LaunchId, status: "exited" }),
    ]);
    let calls = 0;
    await recoverLaunches({
      registry: reg,
      readPidEnv: async () => {
        calls += 1;
        return null;
      },
    });
    expect(calls).toBe(0);
    expect(reg.get("old" as LaunchId)?.status).toBe("exited");
  });

  it("leaves the launch alive when readPidEnv throws (real error, not 'process gone')", async () => {
    // readEnvMacos throws on ps-missing / permission-denied / etc.
    // Recovery must NOT silently treat those as 'process gone' — the
    // tool may still be running, and we'd orphan it.
    const reg = makeRegistry([
      row({ launchId: "alive" as LaunchId, status: "running", pid: 400 }),
    ]);
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await recoverLaunches({
        registry: reg,
        readPidEnv: async () => {
          throw new Error("ps: command not found");
        },
      });
      expect(result.recovered).toHaveLength(1);
      expect(result.exited).toHaveLength(0);
      expect(reg.get("alive" as LaunchId)?.status).toBe("running");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("processes a mixed batch correctly", async () => {
    const reg = makeRegistry([
      row({ launchId: "alive" as LaunchId, status: "running", pid: 100 }),
      row({ launchId: "dead" as LaunchId, status: "running", pid: 200 }),
      row({ launchId: "p" as LaunchId, status: "pending" }),
      row({ launchId: "history" as LaunchId, status: "exited" }),
    ]);
    const result = await recoverLaunches({
      registry: reg,
      readPidEnv: async (pid) =>
        pid === 100 ? "PROMPTCTL_LAUNCH_ID=alive" : null,
    });
    expect(result.recovered.map((l) => l.launchId)).toEqual(["alive"]);
    expect(result.exited.map((l) => l.launchId).sort()).toEqual(["dead", "p"]);
    expect(reg.get("alive" as LaunchId)?.status).toBe("running");
    expect(reg.get("dead" as LaunchId)?.status).toBe("exited");
    expect(reg.get("p" as LaunchId)?.status).toBe("exited");
    expect(reg.get("history" as LaunchId)?.status).toBe("exited");
  });
});
