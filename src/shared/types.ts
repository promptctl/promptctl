// [LAW:one-source-of-truth] Canonical data shapes for the entire app.
// Both main and renderer import from here. No logic, only types.

// Branded string types for compile-time safety
export type PaneId = string & { readonly __brand: "PaneId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type WindowId = string & { readonly __brand: "WindowId" };
export type LaunchId = string & { readonly __brand: "LaunchId" };

export type ToolKind = "claude" | "codex" | "gemini" | "unknown";

// Launch identity — the cross-tab spine.
//
// [LAW:types-are-the-program] A launch is exactly one of three states. The
// type carries the discriminator so consumers cannot read `pid` from a
// row that has not been confirmed running, and cannot read `exitReason`
// from a row that is still alive. Field presence guarantees state.
//
// [LAW:dataflow-not-control-flow] Status is data on every row; no tab
// branches on "do we know this yet" — they switch on status and let the
// type narrow the available fields.
//
// `env` records only the env vars promptctl injected at spawn time —
// PROMPTCTL_LAUNCH_ID, PROMPTCTL_LAUNCH_TOOL, ANTHROPIC_BASE_URL, and
// ANTHROPIC_CUSTOM_HEADERS. We do not capture the child's full env;
// that could leak secrets, and the four we set are the only ones the
// registry and proxy attribution need.

export type ToolLaunchKind = Exclude<ToolKind, "unknown">;

interface LaunchCommon {
  readonly launchId: LaunchId;
  readonly toolKind: ToolLaunchKind;
  readonly paneId: PaneId;
  readonly sessionId: SessionId;
  readonly windowId: WindowId;
  readonly cwd: string;
  readonly startedAt: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchPending extends LaunchCommon {
  readonly status: "pending";
}

export interface LaunchRunning extends LaunchCommon {
  readonly status: "running";
  // pid is null until the pane-pid subscription delivers it. The launch is
  // still "running" — pid is late-binding evidence, not the gate for the
  // status transition (pane-cmd is). [LAW:no-defensive-null-guards] —
  // optionality is explicit on the field, not laundered through guards.
  readonly pid: number | null;
  readonly proxyClientId: string | null;
  readonly sessionFilePath: string | null;
}

export interface LaunchExited extends LaunchCommon {
  readonly status: "exited";
  readonly pid: number | null;
  readonly proxyClientId: string | null;
  readonly sessionFilePath: string | null;
  readonly exitedAt: number;
  readonly exitReason: string;
}

export type Launch = LaunchPending | LaunchRunning | LaunchExited;

// [LAW:dataflow-not-control-flow] Every registry mutation emits the same
// event shape with the post-state launch row. Consumers project off it.
export interface LaunchEvent {
  readonly kind: "created" | "updated" | "exited";
  readonly launch: Launch;
}

// Input to launch:create — everything else (launchId, startedAt, paneId,
// status) is set by the registry.
export interface LaunchSpec {
  readonly toolKind: ToolLaunchKind;
  readonly cwd: string;
  // Promptctl-owned tmux session name to create for this launch. The
  // launch lives in a fresh session so a kill doesn't take other panes
  // with it.
  readonly sessionName: string;
}

// [LAW:one-type-per-behavior] A pane is a pane. toolKind distinguishes controllables.
export interface TmuxPane {
  id: PaneId;
  sessionName: string;
  sessionId: SessionId;
  windowName: string;
  windowId: WindowId;
  windowIndex: number;
  paneIndex: number;
  pid: number;
  currentCommand: string;
  currentPath: string;
  width: number;
  height: number;
  active: boolean;
  toolKind: ToolKind;
}

// Flat list is canonical. Tree is derived.
export interface TmuxSnapshot {
  timestamp: number;
  panes: TmuxPane[];
}

// Derived tree view
export interface TmuxSession {
  name: string;
  id: SessionId;
  windows: TmuxWindow[];
}

export interface TmuxWindow {
  name: string;
  id: WindowId;
  index: number;
  panes: TmuxPane[];
}

// Schedule types (reused inside CommandTrigger)
// [LAW:dataflow-not-control-flow] Schedule kind determines timing calculation
export type TaskSchedule =
  | { kind: "interval"; intervalMs: number }
  | { kind: "idle"; idleMs: number }
  | { kind: "cron"; expression: string };

// Process info for pane detail view
export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
  elapsed: string;
  cpuTime: string;
}

export interface PaneProcesses {
  paneId: PaneId;
  panePid: number;
  children: ProcessInfo[];
  timestamp: number;
}

// [LAW:one-type-per-behavior] Command is the single "do X when Y" abstraction.
// Replaces the former ScheduledTask + OutputMatcher with one unified type.
export type CommandId = string & { readonly __brand: "CommandId" };

export interface Command {
  id: CommandId;
  name: string;
  target: CommandTarget;
  action: CommandAction;
  trigger: CommandTrigger;
  enabled: boolean;
  lastRun: number | null;
  runCount: number;
}

// [LAW:dataflow-not-control-flow] Target kind determines where action is directed.
export type CommandTarget =
  | { kind: "tmux-pane"; paneId: PaneId }
  | { kind: "tmux-session"; sessionId: SessionId }
  | { kind: "tmux-window"; windowId: WindowId }
  | { kind: "app"; resource: string };

// [LAW:dataflow-not-control-flow] Action kind determines what happens.
export type CommandAction =
  | { kind: "send-keys"; text: string; pressEnter: boolean }
  | { kind: "send-command"; command: string }
  | { kind: "notify"; message: string }
  | { kind: "capture-output" }
  | { kind: "kill-pane" }
  | { kind: "log"; message: string };

// [LAW:dataflow-not-control-flow] Trigger kind determines when it happens.
export type CommandTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; schedule: TaskSchedule }
  | { kind: "matcher"; paneId: PaneId | null; pattern: string; flags: string };

export interface CommandEvent {
  commandId: CommandId;
  type: "fired" | "error" | "matched";
  timestamp: number;
  detail?: string;
}

// Prompt library types
export type PromptId = string & { readonly __brand: "PromptId" };

export interface Prompt {
  id: PromptId;
  filename: string; // e.g. "my-prompt.md"
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// Session editor types
// [LAW:one-type-per-behavior] All providers share these types. Provider-specific
// differences live in adapter data (ProviderUIMetadata), not in the type system.
export type ProviderKind = "gemini" | "claude" | "codex";

export interface Project {
  name: string;
  paths: string[]; // storage dirs for this project
  projectRoot: string; // the actual project directory
  provider: ProviderKind;
}

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  summary: string;
  startTime: string;
  lastUpdated: string;
  messageCount: number;
  fileSizeBytes: number;
  previewMessages: string[]; // first few user message previews
}

export interface MessageSummary {
  index: number;
  id: string;
  type: string; // provider-defined: "user" | "assistant" | "gemini" | "info" etc.
  timestamp: string;
  tokens: number; // estimated token count for this message
  preview: string; // first ~300 chars of text content
  hasToolCalls: boolean;
  hasToolResults: boolean;
  toolNames: string[];
  // [LAW:dataflow-not-control-flow] Flags describe the message; the UI decides what to do with them.
  flags: string[]; // provider-defined flag identifiers
  extras: Record<string, string>; // rich metadata (model, tokens, branch) — empty for providers without it
}

// [LAW:one-source-of-truth] One enum of content kinds for the whole app.
// The adapter emits BillableChunk[] tagged by kind; the tokenizer applies a
// per-kind correction factor learned from the Anthropic count_tokens oracle.
// Variability — "which correction to apply" — lives in data, not branches.
export type ContentKind =
  | "user_text"
  | "assistant_text"
  | "tool_use_input"
  | "tool_result_string"
  | "tool_result_array"
  | "thinking_signature"
  | "thinking_text"
  | "system_text";

export interface BillableChunk {
  kind: ContentKind;
  text: string;
}

// Pre-save structural validation — run by the editor coordinator before
// writing a session file. Currently only Claude adapter supports it; Gemini
// sessions have a different failure surface (whole-file JSON integrity,
// enforced by the filesystem).
// [LAW:dataflow-not-control-flow] The UI reads severity/offenders; no branching on id.
export interface SessionValidationOffender {
  lineIndex: number;
  uuid?: string;
  detail: string;
  preview?: string;
}
export interface SessionValidationViolation {
  invariantId: string;
  summary: string;
  offenders: SessionValidationOffender[];
}
// [LAW:one-source-of-truth] One discriminator (`blockedReason`) carries
// both "was the write refused" and "why". A separate `blocked: boolean`
// would invite the two fields to drift; the renderer just tests
// `blockedReason !== null`.
//
// Reasons:
//  - "validation": adapter pre-save validation found one or more
//    violations and the caller did not pass force=true.
//  - "live-tail": the active file is currently being appended to by a
//    running launch's tool process. The block lives in exactly one
//    place ([LAW:single-enforcer]) — saveSession in editor.ts.
export type SessionSaveBlockedReason = "validation" | "live-tail";

export interface SessionSaveResult {
  // path the adapter wrote (or would have written, if blocked).
  path: string | null;
  violations: SessionValidationViolation[];
  // True when the editor wrote despite violations (user forced through).
  forced: boolean;
  // Non-null iff the editor refused to write. Carries the discriminator
  // the renderer reads to pick which dialog/banner to surface.
  blockedReason: SessionSaveBlockedReason | null;
}

// Options for compressToolResults — one operation dispatches truncate vs summarize
// by token thresholds, so the UI exposes a single surface instead of two modes.
// [LAW:dataflow-not-control-flow] Strategy lives in token count, not a branch.
export interface CompressToolsOptions {
  // Tool results at or above this token count are summarized via LLM.
  summarizeThreshold: number;
  // Tool results at or above this (but below summarize) are head/tail truncated.
  // Below this they are skipped — the overhead isn't worth the diff.
  truncateThreshold: number;
  // Don't touch the last N tool results — the assistant typically references
  // them on the next turn, and truncating would degrade continuation context.
  keepLastN: number;
}

// Result of compressToolResults — per-strategy counts let the UI explain outcomes.
export interface CompressToolsResult {
  updated: MessageSummary[];
  truncatedCount: number;
  summarizedCount: number;
  skippedTooSmall: number;
  skippedProtected: number;
}

// Task seam — a single event stream drives cancel + progress UX for every
// long-running main-process operation. New operations reuse this; they do not
// reinvent progress channels. [LAW:one-source-of-truth]
export interface TaskStartedEvent {
  type: "started";
  taskId: string;
  kind: string; // e.g. "compress-tools"
  label: string; // human-readable, shown in toast
  total: number; // 0 if unknown; progress events update it
}
export interface TaskProgressEvent {
  type: "progress";
  taskId: string;
  done: number;
  total: number;
  message?: string; // optional per-step detail ("Summarizing result 3 of 12")
}
export interface TaskDoneEvent {
  type: "done";
  taskId: string;
}
export interface TaskErrorEvent {
  type: "error";
  taskId: string;
  error: string;
}
export interface TaskCancelledEvent {
  type: "cancelled";
  taskId: string;
}
export type TaskEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskDoneEvent
  | TaskErrorEvent
  | TaskCancelledEvent;

// Context Workshop transformation pipeline.
// [LAW:types-are-the-program] One ordered Pipeline of typed Steps; runPipeline
// dispatches on `kind`. Adding a new operation = new StepKind + new op in OPS.
// No per-source branching, no special cases for "where did this step come from."
// [LAW:one-type-per-behavior] Analyzers (heuristics that PROPOSE steps) and
// step ops (pure mutators that APPLY steps) are different types. The heuristic
// is the Analyzer; the operation is the op behind a StepKind. They never live
// in the same type.
export type StepKind = "strip-thinking" | "remove-messages";

export interface Step {
  // Stable identity in the in-memory pipeline. Client-assigned uuid; never
  // persisted today (the pipeline is ephemeral per editor session).
  id: string;
  // Analyzer id that proposed this step, or "manual" if the user added it.
  source: string;
  kind: StepKind;
  // Source-message logical indices (the index field of MessageSummary from
  // the initial loadSession call). Ops resolve these to uuids against the
  // initial source content, so ordering between steps doesn't shift targets.
  targets: number[];
  config?: Record<string, unknown>;
  rationale?: string;
}

export interface Pipeline {
  steps: Step[];
}

// A Step proposed by an analyzer, not yet accepted into the pipeline. The id
// is assigned when the user clicks "Add to pipeline."
export interface Recommendation {
  step: Omit<Step, "id">;
}

// Renderer-side metadata for rendering the Analyzers panel without invoking.
export interface AnalyzerMetadata {
  id: string;
  name: string;
  description: string;
}

export interface AnalyzerResult {
  analyzerId: string;
  recommendations: Recommendation[];
  // One-line summary shown next to the analyzer name when results have landed.
  summary?: string;
}

// Diff entries — adapter-aware semantic diff between two versions of session content.
// [LAW:dataflow-not-control-flow] The UI renders these; never switches on provider.
export type DiffEntry =
  | { kind: "unchanged"; count: number }
  | { kind: "removed"; messages: MessageSummary[] }
  | { kind: "added"; messages: MessageSummary[] }
  | { kind: "modified"; before: MessageSummary; after: MessageSummary };

// Version metadata returned to the renderer.
export interface VersionInfo {
  idx: number;
  ts: string;
  label: string;
  sizeBytes: number;
  tokensTotal: number;
}

export interface VersionMeta {
  sessionPath: string;
  provider: string;
  head: number;
  versions: VersionInfo[];
}

// UI metadata — provided by each adapter as data, consumed by renderer.
// [LAW:dataflow-not-control-flow] The UI reads these; never switches on provider.
export interface MessageTypeStyle {
  label: string;
  color: string; // tailwind classes
}

export interface FlagDefinition {
  label: string;
  color: string;
  tip: string;
}

export interface ProviderUIMetadata {
  badge: { label: string; color: string };
  typeStyles: Record<string, MessageTypeStyle>;
  flagDefinitions: Record<string, FlagDefinition>;
  helpText: {
    description: string;
    resumeCommand: string;
    safeToRemove: string[];
    beCareful: string[];
  };
}

// Full-text session search.
// [LAW:dataflow-not-control-flow] The UI renders from these; null results = tree mode, array = search mode.
// Match offsets are 0-based indices INTO `snippet` (not the original file) so the renderer
// can highlight without re-running regex on every keystroke.
export interface SessionSearchMatch {
  lineNumber: number; // 1-based line in the source file (where rg matched)
  messageRole: string; // provider-defined: "user" | "assistant" | "tool-result" | ...
  snippet: string; // ~200-char window around the match, with newlines collapsed
  matchStart: number; // offset into `snippet` where the highlight begins
  matchEnd: number; // offset into `snippet` where the highlight ends
}

export interface SessionSearchResult {
  provider: ProviderKind;
  projectName: string;
  projectRoot: string;
  sessionId: string;
  filePath: string;
  summary: string;
  lastUpdated: string;
  messageCount: number;
  fileSizeBytes: number;
  totalMatches: number; // total rg hits in the file
  matches: SessionSearchMatch[]; // capped for payload size; see matchesTruncated
  matchesTruncated: boolean; // true if totalMatches > matches.length
}
