// [LAW:single-enforcer] Sole I/O surface for ~/.promptctl/launches.json.
// The registry calls load() once on construction and save() on every
// mutation. No other module reads or writes this file.
//
// [LAW:one-source-of-truth] The on-disk JSON is the persisted projection
// of the registry's in-memory map. Reads on startup feed the in-memory
// map; writes flow the other way. Nothing else owns this file.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Launch } from "../../shared/types";

const LAUNCHES_FILE = join(homedir(), ".promptctl", "launches.json");

// Exported for tests so a fixture launches.json can be probed without
// reaching into the real home dir.
export function launchesPath(): string {
  return LAUNCHES_FILE;
}

export async function loadLaunches(path: string = LAUNCHES_FILE): Promise<Launch[]> {
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    // The file is owned by this module — a malformed shape means a bug or
    // tampering, and we'd rather lose the cache than silently coerce.
    if (!Array.isArray(parsed)) {
      throw new Error(`launches.json: expected array, got ${typeof parsed}`);
    }
    return parsed as Launch[];
  } catch (err) {
    // ENOENT on first run is the expected steady state — surface every
    // other failure so a corrupt file doesn't reduce to an empty registry
    // that then orphans live tools.
    if (isENOENT(err)) return [];
    throw err;
  }
}

export async function saveLaunches(
  launches: readonly Launch[],
  path: string = LAUNCHES_FILE,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: write to a sibling .tmp then rename. A crash mid-write
  // leaves the previous file intact instead of producing half-written
  // JSON that loadLaunches would then refuse to parse.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(launches, null, 2), "utf-8");
  await rename(tmp, path);
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
