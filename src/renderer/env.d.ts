/// <reference types="vite/client" />

import type {
  TmuxSnapshot,
  PaneProcesses,
  Command,
  CommandEvent,
  Prompt,
  Project,
  SessionInfo,
  MessageSummary,
  ProviderKind,
  ProviderUIMetadata,
  CompressToolsOptions,
  CompressToolsResult,
  SessionSaveResult,
  SessionSearchResult,
  TaskEvent,
  VersionMeta,
  DiffEntry,
  TmuxOutputChunk,
  TmuxOutputStateEvent,
} from "../shared/types";
import type {
  ClientInfo,
  ProxyEvent,
  ProxyStatus,
  RequestRecord,
} from "../shared/proxy-events";

// Settings shape mirrored from main/settings/store.ts. Duplicated here so the
// renderer doesn't import main-process modules. Keep in sync with AppSettings.
interface AppSettingsShape {
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  lastRoute: string;
  compressSummarizeThreshold: number;
  compressTruncateThreshold: number;
  compressKeepLastN: number;
  proxyPort: number;
  proxyTarget: string;
  proxyRecordingsDir: string;
}

export interface ElectronAPI {
  send(
    channel:
      | "command:subscribe"
      | "proxy:subscribe"
      | "proxy:unsubscribe",
  ): void;
  send(channel: string, ...args: unknown[]): void;

  invoke(channel: "tmux:topology:get"): Promise<TmuxSnapshot>;
  invoke(channel: "tmux:pane-processes", paneId: string): Promise<PaneProcesses>;
  invoke(
    channel: "tmux:launch-tool",
    kind: string,
    sessionName: string,
    cwd: string,
  ): Promise<string>;
  invoke(channel: "command:list"): Promise<Command[]>;
  invoke(channel: "command:add", command: Command): Promise<void>;
  invoke(channel: "command:remove" | "command:fire" | "tmux:output:subscribe" | "tmux:output:unsubscribe", id: string): Promise<void>;
  invoke(
    channel: "command:update",
    id: string,
    updates: Partial<Command>,
  ): Promise<void>;
  invoke(channel: "prompt:list"): Promise<Prompt[]>;
  invoke(channel: "prompt:save", prompt: Prompt): Promise<Prompt[]>;
  invoke(channel: "prompt:delete", filename: string): Promise<Prompt[]>;
  invoke(channel: "session:list-projects"): Promise<Project[]>;
  invoke(channel: "session:provider-metadata"): Promise<Record<string, ProviderUIMetadata>>;
  invoke(
    channel: "session:list-sessions",
    provider: ProviderKind,
    projectPaths: string[],
  ): Promise<SessionInfo[]>;
  invoke(
    channel: "session:load" | "session:peek",
    provider: ProviderKind,
    filePath: string,
  ): Promise<MessageSummary[]>;
  invoke(
    channel: "session:find",
    provider: ProviderKind,
    sessionId: string,
  ): Promise<{ project: Project; session: SessionInfo } | null>;
  invoke(
    channel: "session:message-content",
    index: number,
  ): Promise<string>;
  invoke(
    channel: "session:message-raw",
    index: number,
  ): Promise<unknown>;
  invoke(
    channel: "session:messages-content",
    indices: number[],
  ): Promise<string>;
  invoke(channel: "session:auto-trim"): Promise<number[]>;
  invoke(
    channel: "session:save",
    indicesToRemove: number[],
    outputPath?: string,
    force?: boolean,
  ): Promise<SessionSaveResult>;
  invoke(channel: "session:list-versions"): Promise<VersionMeta>;
  invoke(
    channel: "session:undo" | "session:redo",
  ): Promise<MessageSummary[] | null>;
  invoke(
    channel: "session:restore-version",
    targetIdx: number,
  ): Promise<MessageSummary[] | null>;
  invoke(
    channel: "session:diff-versions",
    fromIdx: number,
    toIdx: number,
  ): Promise<DiffEntry[]>;
  invoke(channel: "settings:load"): Promise<AppSettingsShape>;
  invoke(
    channel: "settings:save",
    updates: Partial<AppSettingsShape>,
  ): Promise<AppSettingsShape>;
  invoke(
    channel: "anthropic:test-count-tokens",
  ): Promise<{ ok: boolean; tokens?: number; error?: string }>;
  invoke(
    channel: "llm:suggest-compression",
    taskId: string,
    messages: MessageSummary[],
  ): Promise<{ indices: number[]; reason: string }[]>;
  invoke(
    channel: "llm:segment-topics",
    taskId: string,
    messages: MessageSummary[],
    focusQuery: string,
  ): Promise<
    {
      topic: string;
      startIndex: number;
      endIndex: number;
      tokenCount: number;
      relevant: boolean;
    }[]
  >;
  invoke(
    channel: "session:compress-tools",
    taskId: string,
    indices: number[],
    options: CompressToolsOptions,
  ): Promise<CompressToolsResult>;
  invoke(
    channel: "session:search",
    taskId: string,
    query: string,
  ): Promise<SessionSearchResult[]>;
  invoke(channel: "task:cancel", taskId: string): Promise<boolean>;
  invoke(channel: "proxy:status"): Promise<ProxyStatus>;
  invoke(channel: "proxy:list-clients"): Promise<ClientInfo[]>;
  invoke(channel: "proxy:load-har", filePath: string): Promise<ProxyStatus>;
  invoke(channel: "proxy:pick-har"): Promise<string | null>;
  invoke(channel: "tmux:control-state:get"): Promise<TmuxControlState>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  writeClipboard(text: string): void;

  on(
    channel: "tmux:topology",
    listener: (snapshot: TmuxSnapshot) => void,
  ): () => void;
  on(
    channel: "proxy:event",
    listener: (event: ProxyEvent) => void,
  ): () => void;
  on(
    channel: "proxy:status",
    listener: (status: ProxyStatus) => void,
  ): () => void;
  on(
    channel: "proxy:client",
    listener: (info: ClientInfo) => void,
  ): () => void;
  on(
    channel: "proxy:clients",
    listener: (infos: ClientInfo[]) => void,
  ): () => void;
  on(
    channel: "command:list",
    listener: (commands: Command[]) => void,
  ): () => void;
  on(
    channel: "command:event",
    listener: (event: CommandEvent) => void,
  ): () => void;
  on(
    channel: "task:event",
    listener: (event: TaskEvent) => void,
  ): () => void;
  on(
    channel: "tmux:control-state",
    listener: (event: TmuxControlState) => void,
  ): () => void;
  on(
    channel: "tmux:output:chunk",
    listener: (chunk: TmuxOutputChunk) => void,
  ): () => void;
  on(
    channel: "tmux:output:state",
    listener: (event: TmuxOutputStateEvent) => void,
  ): () => void;
  on(
    channel: "session:search-batch",
    listener: (payload: {
      taskId: string;
      results: SessionSearchResult[];
    }) => void,
  ): () => void;
  on(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): () => void;
}

// Mirrors src/main/tmux/control.ts ConnectionStateEvent. Duplicated here so
// the renderer doesn't import main-process modules.
export interface TmuxControlState {
  status: "connecting" | "ready" | "closed";
  reason?: string;
  reconnectAttempts: number;
}

// Structural shape the library's renderer bridge expects. Exposed by the
// preload as `window.tmuxIpc`. Matches IpcRendererLike from
// tmux-control-mode-js/electron/renderer — `on` and `removeListener` both
// receive the IpcRendererEvent (`{ sender?: unknown }`) as the first arg so
// the listener shapes are interchangeable, which is what TS structural
// compatibility checks require at the bridge boundary.
type TmuxIpcListener = (
  event: { sender?: unknown },
  ...args: unknown[]
) => void;

export interface TmuxIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: TmuxIpcListener): void;
  removeListener(channel: string, listener: TmuxIpcListener): void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    tmuxIpc: TmuxIpc;
  }
}

export type { ClientInfo, RequestRecord };
