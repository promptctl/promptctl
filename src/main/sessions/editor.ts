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
  SessionSaveResult,
  Pipeline,
} from "../../shared/types";
import { validateClaudeContent } from "./claude/validator";
import type { TaskHandle } from "../tasks/runner";
import type { ProviderAdapter } from "./types";
import { getAllProviders, getProvider } from "./registry";
import { runPipeline } from "./pipeline/runPipeline";
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

// [LAW:single-enforcer] Sole entry point for "is this file being
// actively written by a live launch?" Every destructive coordinator
// operation — saveSession, compressToolResults, undo, redo,
// restoreVersion — consults this lookup via liveTailGate. Production
// wires it to LaunchRegistry (see main.ts); the default returns null
// so the editor works fine in tests/contexts that have no registry.
//
// [LAW:dataflow-not-control-flow] The lookup is data — a function from
// file path to optional launch identity. Each gated operation does
// the same thing: ask, dispatch on the answer. No branching on "do we
// have a registry" or "is live-tail enabled."
type LiveTailLookup = (filePath: string) => { launchId: string } | null;
let liveTailLookup: LiveTailLookup = () => null;
export function setLiveTailLookup(lookup: LiveTailLookup): void {
  liveTailLookup = lookup;
}

// [LAW:single-enforcer] The one place that decides "is this mutation
// blocked by a live launch?" Every mutating operation calls this; the
// caller dispatches on the discriminated result (saveSession folds
// the block into its structured SessionSaveResult, the others throw
// LiveTailBlockedError so a renderer that bypasses its disabled
// buttons still cannot truncate a live file).
//
// Force=true is the escape hatch — used by saveSession when the user
// explicitly opts in to overwriting a live file via the Force-save
// button in LiveTailBlockedDialog.
type LiveTailGate =
  | { readonly blocked: true; readonly launchId: string }
  | { readonly blocked: false };

function liveTailGate(filePath: string, force: boolean): LiveTailGate {
  if (force) return { blocked: false };
  const launch = liveTailLookup(filePath);
  if (launch === null) return { blocked: false };
  return { blocked: true, launchId: launch.launchId };
}

// Thrown by undo, redo, restoreVersion, and compressToolResults when
// the active file is live-tailed. Caught by the IPC handlers (or
// surfaces as a promise rejection in the renderer's invoke wrapper)
// so the renderer can render a banner. saveSession folds the block
// into its result type rather than throwing — different convenience
// for the same underlying gate decision.
export class LiveTailBlockedError extends Error {
  readonly launchId: string;
  constructor(launchId: string) {
    super(
      `Operation blocked: this file is being written by live launch ${launchId}`,
    );
    this.name = "LiveTailBlockedError";
    this.launchId = launchId;
  }
}

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

// Public read of the active provider — used by IPC handlers that need to
// verify a request matches the loaded session (e.g. session:run-analyzer
// rejecting analyzers scoped to a different provider).
export function getActiveProvider(): ProviderKind {
  return activeProviderId();
}

// Public read of the active file path — used by IPC handlers that run
// against the loaded session (session:run-analyzer) so callers can't
// supply an arbitrary path that points elsewhere.
export function getActivePath(): string {
  return activePath();
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

// [LAW:single-enforcer] Pre-save validation runs here, not in the adapter. The
// adapter is the format translator; policy (block vs. force) is a coordinator
// decision. Validators that apply across providers register here.
//
// Only Claude today — Gemini's edit surface only removes entries from
// messages[] before JSON.stringify, which can't break session_object_shape
// (format-enforced) or message_id_stability (adapter preserves ids in its
// filter). There is no failure path through the editor, so no validator runs.
// A validator would be [LAW:no-defensive-null-guards] with no else-branch.
//
// [LAW:dataflow-not-control-flow] providers that don't implement
// previewSaveContent contribute an empty violation list — same code path, data
// decides the outcome.
function validatePreSave(
  adapter: ProviderAdapter,
  indicesToRemove: number[],
): SessionSaveResult["violations"] {
  if (adapter.id !== "claude") return [];
  if (!adapter.previewSaveContent) return [];
  const content = adapter.previewSaveContent(indicesToRemove);
  return validateClaudeContent(content).violations;
}

export async function saveSession(
  indicesToRemove: number[],
  outputPath?: string,
  force = false,
): Promise<SessionSaveResult> {
  const adapter = active();
  // Destination is the file we'd actually write — outputPath overrides
  // the active path. The live-tail check runs against the destination
  // because that's the file that would be clobbered. Save-as to a
  // different path is therefore not blocked by live-tail on the
  // source.
  const destination = outputPath ?? activePath();

  // [LAW:single-enforcer] All destructive operations consult
  // liveTailGate; saveSession folds a block into its structured
  // result, the other mutators throw LiveTailBlockedError. One gate,
  // two dispatch shapes — the renderer wants different surfaces for
  // "save was refused" (modal with force-save) vs. "undo just isn't
  // available right now" (button disabled + banner).
  const gate = liveTailGate(destination, force);
  if (gate.blocked) {
    return {
      path: null,
      violations: [],
      forced: false,
      blockedReason: "live-tail",
    };
  }

  const violations = validatePreSave(adapter, indicesToRemove);
  if (violations.length > 0 && !force) {
    return {
      path: null,
      violations,
      forced: false,
      blockedReason: "validation",
    };
  }

  // Capture pre-edit baseline if first edit
  await ensureBaselineForActive();

  const writtenPath = await adapter.saveSession(indicesToRemove, outputPath);

  // If outputPath was used and differs from active, switch active path
  if (outputPath && outputPath !== activeFilePath) {
    activeFilePath = outputPath;
  }

  const removalLabel =
    indicesToRemove.length === 0
      ? "Saved (no removals)"
      : `Removed ${indicesToRemove.length} message${indicesToRemove.length === 1 ? "" : "s"}`;
  const label =
    violations.length > 0
      ? `${removalLabel} (saved with ${violations.length} violation${violations.length === 1 ? "" : "s"})`
      : removalLabel;
  await recordCurrentVersion(label);

  return {
    path: writtenPath,
    violations,
    forced: violations.length > 0,
    blockedReason: null,
  };
}

export async function compressToolResults(
  indices: number[],
  options: CompressToolsOptions,
  handle?: TaskHandle,
): Promise<CompressToolsResult> {
  const adapter = active();
  // Gate before touching the adapter. Compression rewrites the file
  // via adapter.saveSession([]) further down, so an ungated path
  // would silently truncate a live launch's JSONL — same destructive
  // shape as a save without the structured "blocked" return.
  const gate = liveTailGate(activePath(), false);
  if (gate.blocked) throw new LiveTailBlockedError(gate.launchId);
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

// [LAW:single-enforcer] applyPipeline is the only path that mutates a session
// via the unified pipeline. Reads current disk content, runs the pipeline,
// validates (Claude only — same policy as saveSession), writes through the
// coordinator's writeFile (not the adapter's saveSession), records a version
// with a structured label.
//
// Pattern parallel: undo/redo/restoreVersion also writeFile directly through
// the coordinator and rely on the adapter being reloaded by the next
// loadSession. The adapter's saveSession path exists for in-place edits
// (compressToolResults) where in-memory state must stay consistent with
// disk. applyPipeline works content-pure, so we don't need that path.
//
// force=true: bypasses both the live-tail gate and structural validation.
// Wired to ValidationViolationsDialog and LiveTailBlockedDialog's "Force
// save" — the renderer flow when the user has reviewed the warning and
// explicitly opted in. Slice 3's structural-repair analyzer will reduce
// the need for the validation-force path in practice; slice 4 adds a
// pre-apply diff so the user can preview what they're forcing.
export async function applyPipeline(
  pipeline: Pipeline,
  force = false,
): Promise<SessionSaveResult> {
  // [LAW:one-source-of-truth] Snapshot the active state once at the top.
  // Between awaits below, another IPC handler (notably `session:load`) can
  // change activeAdapter / activeFilePath / activeProvider; the prior code
  // captured filePath but later called `ensureBaselineForActive()` and
  // `activeProviderId()` which read FRESH globals — so a session switch
  // mid-apply could record the baseline/version against the wrong file.
  // Using the snapshot consistently keeps every I/O scoped to the file
  // this invocation was issued against.
  const adapter = active();
  const filePath = activePath();
  const provider = activeProviderId();

  // [LAW:single-enforcer] Same gate as saveSession; `force` bypasses both
  // the validation block AND the live-tail block (the inner `liveTailGate`
  // returns unblocked when force=true). The dialog flow — Force save in
  // ValidationViolationsDialog and LiveTailBlockedDialog — is the only
  // path that sets force=true, and the user has explicitly opted in via
  // those dialogs by the time we get here.
  const gate = liveTailGate(filePath, force);
  if (gate.blocked) {
    return {
      path: null,
      violations: [],
      forced: false,
      blockedReason: "live-tail",
    };
  }

  const sourceContent = await readFile(filePath, "utf-8");
  const newContent = runPipeline(sourceContent, pipeline);

  // [LAW:dataflow-not-control-flow] Empty-violations list for non-claude
  // providers — same code path, the data decides the outcome.
  const violations =
    adapter.id === "claude"
      ? validateClaudeContent(newContent).violations
      : [];
  if (violations.length > 0 && !force) {
    return {
      path: null,
      violations,
      forced: false,
      blockedReason: "validation",
    };
  }

  // Inline the baseline + version-recording steps using the captured
  // filePath/provider rather than activePath()/activeProviderId() helpers.
  // That keeps each await in the chain scoped to the same session this
  // call was issued against.
  const baselineSourceTokens = adapter
    .summarizeContent(sourceContent)
    .reduce((sum, m) => sum + m.tokens, 0);
  await ensureBaseline(filePath, provider, baselineSourceTokens);
  await writeFile(filePath, newContent, "utf-8");

  const baseLabel = formatPipelineLabel(pipeline);
  const label =
    violations.length > 0
      ? `${baseLabel} (forced with ${violations.length} violation${violations.length === 1 ? "" : "s"})`
      : baseLabel;
  const newTokens = adapter
    .summarizeContent(newContent)
    .reduce((sum, m) => sum + m.tokens, 0);
  await recordVersion(filePath, provider, newContent, label, newTokens);

  return {
    path: filePath,
    violations,
    forced: violations.length > 0,
    blockedReason: null,
  };
}

function formatPipelineLabel(pipeline: Pipeline): string {
  if (pipeline.steps.length === 0) return "Applied empty pipeline";
  const parts = pipeline.steps.map((s) => {
    // Dedupe targets when counting — ops dedupe via UUID Set, so the label
    // must match what actually happened, not what was queued.
    const count = new Set(s.targets).size;
    return `${s.kind} (${count} message${count === 1 ? "" : "s"} from ${s.source})`;
  });
  return `Applied ${pipeline.steps.length} step${pipeline.steps.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// Reload the active session after applyPipeline writes — mirrors the
// post-undo/redo/restoreVersion pattern. The renderer calls session:load
// directly after a successful apply, so this isn't called from main today,
// but it's exposed so any future caller that needs the post-apply summaries
// has a single entrypoint.
export async function reloadActive(): Promise<MessageSummary[]> {
  return active().loadSession(activePath());
}

export async function listVersions(): Promise<VersionMeta> {
  return storeListVersions(activePath());
}

export async function undo(): Promise<MessageSummary[] | null> {
  // [LAW:single-enforcer] Same gate as save: undo's writeFile call
  // would clobber a live launch's appended output. Throws so the
  // renderer can surface the block — but in practice the UI disables
  // the Undo button while live-tail is active, so this throw is
  // defense-in-depth for direct IPC / future callers.
  const gate = liveTailGate(activePath(), false);
  if (gate.blocked) throw new LiveTailBlockedError(gate.launchId);
  const result = await storeUndo(activePath());
  if (!result) return null;
  await writeFile(activePath(), result.content, "utf-8");
  return active().loadSession(activePath());
}

export async function redo(): Promise<MessageSummary[] | null> {
  const gate = liveTailGate(activePath(), false);
  if (gate.blocked) throw new LiveTailBlockedError(gate.launchId);
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
  const gate = liveTailGate(filePath, false);
  if (gate.blocked) throw new LiveTailBlockedError(gate.launchId);

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
  liveTailLookup = () => null;
}

export { listSessions } from "./registry-helpers";
export { searchSessions } from "./search";
