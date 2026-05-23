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
    // The file is owned by this module — a malformed top-level shape
    // means a bug or tampering, and we'd rather throw than silently
    // coerce. Per-row shape gets validated below.
    if (!Array.isArray(parsed)) {
      throw new Error(`launches.json: expected array, got ${typeof parsed}`);
    }
    // [LAW:no-silent-fallbacks] Each row is validated as a real Launch
    // (carries one of the three statuses + the common shape fields). A
    // row that fails is dropped with a loud warning rather than blindly
    // cast — passing it through would let an invalid discriminator land
    // in the registry and crash downstream code that exhaustively
    // switches on `status`. Dropping one bad row while keeping the
    // rest preserves recovery for the launches that ARE valid.
    const valid: Launch[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const candidate = parsed[i] as unknown;
      const reason = validateLaunchShape(candidate);
      if (reason !== null) {
        console.warn(
          `[launch] launches.json row ${i} is malformed (${reason}); dropping`,
        );
        continue;
      }
      valid.push(candidate as Launch);
    }
    return valid;
  } catch (err) {
    // ENOENT on first run is the expected steady state — surface every
    // other failure so a corrupt file doesn't reduce to an empty registry
    // that then orphans live tools.
    if (isENOENT(err)) return [];
    throw err;
  }
}

// Exported for unit tests. Returns a reason string when the candidate
// is NOT a valid Launch (for diagnostic logging), or null when it
// passes the shape check. Validates the discriminated-union invariants
// — every status carries its own required fields, and the common
// fields (launchId, paneId, etc.) are always present and the right
// primitive type.
export function validateLaunchShape(candidate: unknown): string | null {
  if (typeof candidate !== "object" || candidate === null) {
    return "row is not an object";
  }
  const row = candidate as Record<string, unknown>;
  for (const key of ["launchId", "toolKind", "paneId", "sessionId", "windowId", "cwd"]) {
    if (typeof row[key] !== "string") return `missing/non-string ${key}`;
  }
  if (typeof row.startedAt !== "number") return "missing/non-number startedAt";
  if (typeof row.env !== "object" || row.env === null) return "missing env";
  const status = row.status;
  if (status === "pending") return null;
  if (status === "running" || status === "exited") {
    // pid is either a number or null for both states.
    if (row.pid !== null && typeof row.pid !== "number") {
      return "running/exited pid must be number or null";
    }
    if (
      row.proxyClientId !== null &&
      typeof row.proxyClientId !== "string"
    ) {
      return "running/exited proxyClientId must be string or null";
    }
    if (
      row.sessionFilePath !== null &&
      typeof row.sessionFilePath !== "string"
    ) {
      return "running/exited sessionFilePath must be string or null";
    }
    if (status === "exited") {
      if (typeof row.exitedAt !== "number") return "exited row missing exitedAt";
      if (typeof row.exitReason !== "string") return "exited row missing exitReason";
    }
    return null;
  }
  return `unknown status: ${String(status)}`;
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
