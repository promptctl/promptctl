// [LAW:one-source-of-truth] Canonical data shapes for the entire app.
// Both main and renderer import from here. No logic, only types.

// Branded string types for compile-time safety
export type PaneId = string & { readonly __brand: "PaneId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type WindowId = string & { readonly __brand: "WindowId" };

export type ToolKind = "claude" | "codex" | "gemini" | "unknown";

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

// IPC push payloads
export interface PaneOutputChunk {
  paneId: PaneId;
  data: string;
  timestamp: number;
}

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
export type SessionProvider = "gemini" | "claude" | "codex";

export interface GeminiProject {
  name: string;
  paths: string[]; // all tmp dirs for this project (merged duplicates)
  projectRoot: string; // the actual project directory
  provider: SessionProvider;
}

export interface GeminiSessionInfo {
  sessionId: string;
  filePath: string;
  summary: string;
  startTime: string;
  lastUpdated: string;
  messageCount: number;
  fileSizeBytes: number;
  previewMessages: string[]; // first few user message previews
}

export interface GeminiMessageSummary {
  index: number;
  id: string;
  type: string; // "user" | "gemini" | "info"
  timestamp: string;
  sizeBytes: number;
  preview: string; // first ~200 chars of text content
  hasToolCalls: boolean;
  hasToolResults: boolean;
  toolNames: string[];
  flags: GeminiMessageFlag[];
}

// [LAW:dataflow-not-control-flow] Flags describe the message; the UI decides what to do with them.
export type GeminiMessageFlag =
  | "oversized" // > 50KB
  | "repetitive" // detected repetition patterns
  | "loop-detection" // system loop detection message
  | "tool-output" // contains tool call results
  | "system-noise"; // info/system messages with no user value
