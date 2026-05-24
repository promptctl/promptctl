// Round-trip unit test for launches.json — exercises real fs in a tmp dir
// so the atomic-write path (write .tmp, rename) is observable end-to-end.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLaunches, saveLaunches, validateLaunchShape } from "./persistence";
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

function makeRow(id: string): Launch {
  return {
    launchId: id as LaunchId,
    toolKind: "claude",
    paneId: PANE,
    sessionId: SESS,
    windowId: WIN,
    cwd: "/repo",
    startedAt: 1700000000000,
    env: { PROMPTCTL_LAUNCH_ID: id },
    status: "running",
    pid: 42,
    proxyClientId: null,
    sessionFilePath: null,
  };
}

describe("launches.json persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptctl-launches-"));
    path = join(dir, "launches.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when the file does not exist", async () => {
    expect(await loadLaunches(path)).toEqual([]);
  });

  it("round-trips an array of rows", async () => {
    const rows = [makeRow("a"), makeRow("b")];
    await saveLaunches(rows, path);
    const back = await loadLaunches(path);
    expect(back).toEqual(rows);
  });

  it("leaves no .tmp behind on success", async () => {
    await saveLaunches([makeRow("a")], path);
    const entries = await readdir(dir);
    expect(entries).toContain("launches.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("rejects a non-array file rather than silently coercing to []", async () => {
    await saveLaunches([makeRow("a")], path);
    // Hand-corrupt to a non-array shape.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, '{"not":"an array"}', "utf-8");
    await expect(loadLaunches(path)).rejects.toThrow(/expected array/);
  });

  it("drops malformed rows from a mixed-validity file with a warning", async () => {
    const { writeFile } = await import("node:fs/promises");
    // First row is valid; second is missing status; third has the
    // wrong type for paneId; fourth is a string (not even an object).
    const file = [
      makeRow("good"),
      {
        launchId: "b",
        toolKind: "claude",
        paneId: "%1",
        sessionId: "$1",
        windowId: "@1",
        cwd: "/x",
        startedAt: 1,
        env: {},
      },
      { ...makeRow("c"), paneId: 42 },
      "not an object",
    ];
    await writeFile(path, JSON.stringify(file), "utf-8");
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const rows = await loadLaunches(path);
      expect(rows.map((r) => r.launchId)).toEqual(["good"]);
      expect(warnings.length).toBe(3); // one warning per dropped row
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("validateLaunchShape", () => {
  function baseCommon() {
    return {
      launchId: "L",
      toolKind: "claude",
      paneId: "%1",
      sessionId: "$1",
      windowId: "@1",
      cwd: "/x",
      startedAt: 1,
      env: {},
    };
  }

  it("accepts a well-formed pending row", () => {
    expect(
      validateLaunchShape({ ...baseCommon(), status: "pending" }),
    ).toBeNull();
  });

  it("accepts a well-formed running row with pid", () => {
    expect(
      validateLaunchShape({
        ...baseCommon(),
        status: "running",
        pid: 42,
        proxyClientId: null,
        sessionFilePath: null,
      }),
    ).toBeNull();
  });

  it("accepts a well-formed exited row", () => {
    expect(
      validateLaunchShape({
        ...baseCommon(),
        status: "exited",
        pid: 42,
        proxyClientId: null,
        sessionFilePath: null,
        exitedAt: 2,
        exitReason: "tool exited",
      }),
    ).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(validateLaunchShape("not an object")).toContain("not an object");
    expect(validateLaunchShape(null)).toContain("not an object");
  });

  it("rejects missing required fields", () => {
    const missing = { ...baseCommon(), status: "pending" } as Record<
      string,
      unknown
    >;
    delete missing.paneId;
    expect(validateLaunchShape(missing)).toContain("paneId");
  });

  it("rejects an unknown status discriminator", () => {
    expect(validateLaunchShape({ ...baseCommon(), status: "weird" })).toContain(
      "unknown status",
    );
  });

  it("rejects an exited row missing exitReason", () => {
    expect(
      validateLaunchShape({
        ...baseCommon(),
        status: "exited",
        pid: null,
        proxyClientId: null,
        sessionFilePath: null,
        exitedAt: 2,
      }),
    ).toContain("exitReason");
  });
});
