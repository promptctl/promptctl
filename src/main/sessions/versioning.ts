// [LAW:single-enforcer] All conversation versioning routes through here.
// [LAW:one-source-of-truth] Version metadata lives in ~/.promptctl/versions/<hash>/meta.json.
//
// Versioning model: linear history with redo drop.
// - `head` always points to the version currently on disk at the session path.
// - `recordVersion` at head < tip drops the tail (redo branch lost).
// - `undo`/`redo` move head, return content (caller writes to disk).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_VERSIONS_ROOT = path.join(
  process.env.HOME ?? "",
  ".promptctl",
  "versions",
);

let versionsRoot = DEFAULT_VERSIONS_ROOT;

export interface VersionInfo {
  idx: number;
  ts: string; // ISO timestamp
  label: string;
  sizeBytes: number;
  tokensTotal: number;
}

export interface VersionMeta {
  sessionPath: string;
  provider: string;
  head: number; // 0 if no versions; otherwise idx of currently-on-disk version
  versions: VersionInfo[];
}

interface VersionState {
  meta: VersionMeta;
  metaPath: string;
  versionsDir: string;
}

// --- Internal helpers ---

function hashPath(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 16);
}

function dirFor(sessionPath: string): string {
  return path.join(versionsRoot, hashPath(sessionPath));
}

function versionFile(versionsDir: string, idx: number): string {
  return path.join(versionsDir, `v${String(idx).padStart(4, "0")}`);
}

function emptyMeta(sessionPath: string, provider: string): VersionMeta {
  return { sessionPath, provider, head: 0, versions: [] };
}

async function readMeta(
  sessionPath: string,
  provider: string,
): Promise<VersionState> {
  const versionsDir = dirFor(sessionPath);
  const metaPath = path.join(versionsDir, "meta.json");

  let meta: VersionMeta;
  try {
    const raw = await readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as VersionMeta;
    // Validate shape — corrupted file → start fresh
    if (
      !parsed.sessionPath ||
      typeof parsed.head !== "number" ||
      !Array.isArray(parsed.versions)
    ) {
      meta = emptyMeta(sessionPath, provider);
    } else {
      meta = parsed;
    }
  } catch {
    meta = emptyMeta(sessionPath, provider);
  }

  return { meta, metaPath, versionsDir };
}

async function writeMeta(state: VersionState): Promise<void> {
  await mkdir(state.versionsDir, { recursive: true });
  await writeFile(state.metaPath, JSON.stringify(state.meta, null, 2), "utf-8");
}

// --- Public API ---

/**
 * Record a new version. Advances head to the new version's idx.
 * If head < tip, drops tail versions before recording (redo branch lost).
 *
 * Returns the new VersionInfo.
 */
export async function recordVersion(
  sessionPath: string,
  provider: string,
  content: string,
  label: string,
  tokensTotal: number,
): Promise<VersionInfo> {
  const state = await readMeta(sessionPath, provider);

  // Drop redo branch if recording at non-tip
  if (state.meta.head < state.meta.versions.length) {
    state.meta.versions = state.meta.versions.slice(0, state.meta.head);
  }

  const nextIdx =
    state.meta.versions.length > 0
      ? state.meta.versions[state.meta.versions.length - 1].idx + 1
      : 1;

  await mkdir(state.versionsDir, { recursive: true });
  await writeFile(versionFile(state.versionsDir, nextIdx), content, "utf-8");

  const info: VersionInfo = {
    idx: nextIdx,
    ts: new Date().toISOString(),
    label,
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    tokensTotal,
  };

  state.meta.versions.push(info);
  state.meta.head = nextIdx;
  await writeMeta(state);

  return info;
}

/**
 * Ensure a baseline (v1) snapshot exists for the session. If no versions exist,
 * records the current file content as v1 with label "Initial snapshot".
 *
 * Returns true if a baseline was created, false if one already existed.
 */
export async function ensureBaseline(
  sessionPath: string,
  provider: string,
  tokensTotal: number,
): Promise<boolean> {
  const state = await readMeta(sessionPath, provider);
  if (state.meta.versions.length > 0) return false;

  const currentContent = await readFile(sessionPath, "utf-8");
  await recordVersion(
    sessionPath,
    provider,
    currentContent,
    "Initial snapshot",
    tokensTotal,
  );
  return true;
}

/** Returns the version metadata. Empty meta if no versions exist. */
export async function listVersions(sessionPath: string): Promise<VersionMeta> {
  const state = await readMeta(sessionPath, "");
  return state.meta;
}

/** Returns the content of a specific version, or null if not found. */
export async function getVersionContent(
  sessionPath: string,
  idx: number,
): Promise<string | null> {
  const state = await readMeta(sessionPath, "");
  const info = state.meta.versions.find((v) => v.idx === idx);
  if (!info) return null;
  try {
    return await readFile(versionFile(state.versionsDir, idx), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Move head to the previous version. Returns the content at the new head,
 * or null if already at the first version (no undo possible).
 *
 * Caller is responsible for writing the returned content to the session path.
 */
export async function undo(sessionPath: string): Promise<{
  content: string;
  newHead: number;
} | null> {
  const state = await readMeta(sessionPath, "");
  if (state.meta.head <= 1) return null;
  const newHead = state.meta.head - 1;
  const content = await getVersionContent(sessionPath, newHead);
  if (content == null) return null;
  state.meta.head = newHead;
  await writeMeta(state);
  return { content, newHead };
}

/**
 * Move head to the next version. Returns the content at the new head,
 * or null if already at the tip (no redo possible).
 */
export async function redo(sessionPath: string): Promise<{
  content: string;
  newHead: number;
} | null> {
  const state = await readMeta(sessionPath, "");
  const tip =
    state.meta.versions.length > 0
      ? state.meta.versions[state.meta.versions.length - 1].idx
      : 0;
  if (state.meta.head >= tip) return null;
  const newHead = state.meta.head + 1;
  const content = await getVersionContent(sessionPath, newHead);
  if (content == null) return null;
  state.meta.head = newHead;
  await writeMeta(state);
  return { content, newHead };
}

/**
 * Restore an arbitrary version. Records a new "Restored from vN" version
 * containing the content of the target version. Returns the new VersionInfo.
 *
 * This preserves history — restore is just another edit, not a head jump.
 */
export async function restoreVersion(
  sessionPath: string,
  provider: string,
  targetIdx: number,
): Promise<VersionInfo | null> {
  const state = await readMeta(sessionPath, provider);
  const target = state.meta.versions.find((v) => v.idx === targetIdx);
  if (!target) return null;
  const content = await getVersionContent(sessionPath, targetIdx);
  if (content == null) return null;

  return recordVersion(
    sessionPath,
    provider,
    content,
    `Restored from v${targetIdx}`,
    target.tokensTotal,
  );
}

/** For testing: override the versions root. Pass null to restore the default. */
export function _setVersionsRootForTesting(root: string | null): void {
  versionsRoot = root ?? DEFAULT_VERSIONS_ROOT;
}

export function _versionsRoot(): string {
  return versionsRoot;
}
