// [LAW:single-enforcer] All session editor operations route through here.
// This is a thin coordinator — all format-specific logic lives in provider adapters.
// Versioning is enforced here uniformly: every edit op records a version after success.
import { readFile, writeFile } from "node:fs/promises";
import type {
  ProviderKind,
  ProviderUIMetadata,
  Project,
  SessionInfo,
  MessageSummary,
  DiffEntry,
  VersionMeta,
  CompressToolsOptions,
  CompressToolsResult,
} from "../../shared/types";
import type { TaskHandle } from "../tasks/runner";
import type { ProviderAdapter } from "./types";
import { getAllProviders, getProvider } from "./registry";
import {
  recordVersion,
  ensureBaseline,
  listVersions as storeListVersions,
  getVersionContent,
  undo as storeUndo,
  redo as storeRedo,
  restoreVersion as storeRestoreVersion,
} from "./versioning";

let activeAdapter: ProviderAdapter | null = null;
let activeFilePath: string | null = null;
let activeProvider: ProviderKind | null = null;

export async function listAllProjects(): Promise<Project[]> {
  const results = await Promise.all(
    getAllProviders().map((a) => a.listProjects()),
  );
  return results.flat();
}

export function getAllProviderMetadata(): Record<string, ProviderUIMetadata> {
  const meta: Record<string, ProviderUIMetadata> = {};
  for (const adapter of getAllProviders()) {
    meta[adapter.id] = adapter.uiMetadata;
  }
  return meta;
}

// [LAW:single-enforcer] Deep-link session discovery. The URL carries (provider,
// sessionId); this resolves to the (project, session) pair selectSession needs.
export async function findSession(
  provider: ProviderKind,
  sessionId: string,
): Promise<{ project: Project; session: SessionInfo } | null> {
  return getProvider(provider).findSession(sessionId);
}

export async function loadSession(
  provider: ProviderKind,
  filePath: string,
): Promise<MessageSummary[]> {
  activeAdapter = getProvider(provider);
  activeFilePath = filePath;
  activeProvider = provider;
  return activeAdapter.loadSession(filePath);
}

function active(): ProviderAdapter {
  if (!activeAdapter) throw new Error("No session loaded");
  return activeAdapter;
}

function activePath(): string {
  if (!activeFilePath) throw new Error("No session loaded");
  return activeFilePath;
}

function activeProviderId(): ProviderKind {
  if (!activeProvider) throw new Error("No session loaded");
  return activeProvider;
}

export function getMessageContent(index: number): string {
  return active().getMessageContent(index);
}

export function getMessageRaw(index: number): unknown {
  return active().getMessageRaw(index);
}

export function getMessagesContent(indices: number[]): string {
  return active().getMessagesContent(indices);
}

export function autoTrimSuggestions(): number[] {
  return active().autoTrimSuggestions();
}

// Sum of billable tokens for content as it would be parsed by the active adapter.
// Stateless — does NOT reload the adapter (that would discard in-memory edits).
function tokensForContent(content: string): number {
  const adapter = active();
  return adapter
    .summarizeContent(content)
    .reduce((sum, m) => sum + m.tokens, 0);
}

async function recordCurrentVersion(label: string): Promise<void> {
  const filePath = activePath();
  const provider = activeProviderId();
  const content = await readFile(filePath, "utf-8");
  const tokens = tokensForContent(content);
  await recordVersion(filePath, provider, content, label, tokens);
}

async function ensureBaselineForActive(): Promise<void> {
  const filePath = activePath();
  const provider = activeProviderId();
  const content = await readFile(filePath, "utf-8");
  const tokens = tokensForContent(content);
  await ensureBaseline(filePath, provider, tokens);
}

export async function saveSession(
  indicesToRemove: number[],
  outputPath?: string,
): Promise<string> {
  // Capture pre-edit baseline if first edit
  await ensureBaselineForActive();

  const result = await active().saveSession(indicesToRemove, outputPath);

  // If outputPath was used and differs from active, switch active path
  if (outputPath && outputPath !== activeFilePath) {
    activeFilePath = outputPath;
  }

  const label =
    indicesToRemove.length === 0
      ? "Saved (no removals)"
      : `Removed ${indicesToRemove.length} message${indicesToRemove.length === 1 ? "" : "s"}`;
  await recordCurrentVersion(label);
  return result;
}

export async function compressToolResults(
  indices: number[],
  options: CompressToolsOptions,
  handle?: TaskHandle,
): Promise<CompressToolsResult> {
  const adapter = active();
  if (!adapter.compressToolResults) {
    throw new Error(
      `Provider ${adapter.id} does not support tool result compression`,
    );
  }

  const result = await adapter.compressToolResults(indices, options, handle);

  // Only baseline + persist + record if something actually changed.
  // If everything was skipped (too small or protected), don't pollute history.
  if (result.updated.length > 0) {
    await ensureBaselineForActive();
    // compressToolResults modifies in-memory; we need to persist for the version snapshot.
    await adapter.saveSession([]);

    // Label reads naturally when only one strategy fired; combines when both did.
    // [LAW:dataflow-not-control-flow] The counts decide the phrasing, not a mode flag.
    const n = result.updated.length;
    const plural = n === 1 ? "" : "s";
    let label: string;
    if (result.summarizedCount > 0 && result.truncatedCount > 0) {
      label = `Compressed ${n} tool result${plural} (summarized ${result.summarizedCount}, truncated ${result.truncatedCount})`;
    } else if (result.summarizedCount > 0) {
      label = `Summarized ${result.summarizedCount} tool result${result.summarizedCount === 1 ? "" : "s"}`;
    } else {
      label = `Truncated ${result.truncatedCount} tool result${result.truncatedCount === 1 ? "" : "s"}`;
    }
    await recordCurrentVersion(label);
  }

  return result;
}

export async function listVersions(): Promise<VersionMeta> {
  return storeListVersions(activePath());
}

export async function undo(): Promise<MessageSummary[] | null> {
  const result = await storeUndo(activePath());
  if (!result) return null;
  await writeFile(activePath(), result.content, "utf-8");
  return active().loadSession(activePath());
}

export async function redo(): Promise<MessageSummary[] | null> {
  const result = await storeRedo(activePath());
  if (!result) return null;
  await writeFile(activePath(), result.content, "utf-8");
  return active().loadSession(activePath());
}

export async function restoreVersion(
  targetIdx: number,
): Promise<MessageSummary[] | null> {
  const filePath = activePath();
  const provider = activeProviderId();

  // First write the target version's content as the new file content
  const targetContent = await getVersionContent(filePath, targetIdx);
  if (targetContent == null) return null;
  await writeFile(filePath, targetContent, "utf-8");

  // Then record it as a new version (Restored from vN)
  await storeRestoreVersion(filePath, provider, targetIdx);

  return active().loadSession(filePath);
}

export async function diffVersions(
  fromIdx: number,
  toIdx: number,
): Promise<DiffEntry[]> {
  const filePath = activePath();
  const [fromContent, toContent] = await Promise.all([
    getVersionContent(filePath, fromIdx),
    getVersionContent(filePath, toIdx),
  ]);
  if (fromContent == null || toContent == null) return [];
  return active().diffContent(fromContent, toContent);
}

// Stateless peek — reads a session file and returns its messages WITHOUT
// mutating the coordinator's active adapter state. The editor singleton
// (activeAdapter / activeFilePath / activeProvider) stays untouched, so a
// peek never clobbers whatever session the user is editing or enters.
// [LAW:single-enforcer] Only path that can read a session without "loading" it.
export async function peekSession(
  provider: ProviderKind,
  filePath: string,
): Promise<MessageSummary[]> {
  const adapter = getProvider(provider);
  const content = await readFile(filePath, "utf-8");
  return adapter.summarizeContent(content);
}

// Reset coordinator state — exposed for tests.
export function _resetForTesting(): void {
  activeAdapter = null;
  activeFilePath = null;
  activeProvider = null;
}

export { listSessions } from "./registry-helpers";
export { searchSessions } from "./search";
