// Round-trip unit test for launches.json — exercises real fs in a tmp dir
// so the atomic-write path (write .tmp, rename) is observable end-to-end.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLaunches, saveLaunches } from "./persistence";
import type { Launch, LaunchId, PaneId, SessionId, WindowId } from "../../shared/types";

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
});
