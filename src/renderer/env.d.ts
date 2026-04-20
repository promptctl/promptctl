/// <reference types="vite/client" />

import type {
  TmuxSnapshot,
  PaneOutputChunk,
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
} from "../shared/types";

// Settings shape mirrored from main/settings/store.ts. Duplicated here so the
// renderer doesn't import main-process modules. Keep in sync with AppSettings.
interface AppSettingsShape {
  openaiApiKey: string;
  openaiModel: string;
  lastRoute: string;
  compressSummarizeThreshold: number;
  compressTruncateThreshold: number;
  compressKeepLastN: number;
}

export interface ElectronAPI {
  send(channel: "tmux:subscribe" | "tmux:unsubscribe" | "command:subscribe"): void;
  send(channel: "tmux:watch-pane" | "tmux:unwatch-pane", paneId: string): void;
  send(channel: string, ...args: unknown[]): void;

  invoke(channel: "tmux:snapshot"): Promise<TmuxSnapshot>;
  invoke(
    channel: "tmux:send-keys",
    paneId: string,
    text: string,
    pressEnter?: boolean,
  ): Promise<void>;
  invoke(
    channel: "tmux:send-keys-literal",
    paneId: string,
    data: string,
  ): Promise<void>;
  invoke(
    channel: "tmux:capture-pane",
    paneId: string,
    start: number,
    end: number,
  ): Promise<string>;
  invoke(channel: "tmux:pane-processes", paneId: string): Promise<PaneProcesses>;
  invoke(
    channel: "tmux:launch-tool",
    kind: string,
    sessionName: string,
    cwd: string,
  ): Promise<string>;
  invoke(channel: "command:list"): Promise<Command[]>;
  invoke(channel: "command:add", command: Command): Promise<void>;
  invoke(channel: "command:remove" | "command:fire", id: string): Promise<void>;
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
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  writeClipboard(text: string): void;

  on(
    channel: "tmux:snapshot",
    listener: (snapshot: TmuxSnapshot) => void,
  ): () => void;
  on(
    channel: "tmux:pane-output",
    listener: (chunk: PaneOutputChunk) => void,
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

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
