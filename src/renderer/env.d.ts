/// <reference types="vite/client" />

import type {
  TmuxSnapshot,
  PaneOutputChunk,
  PaneProcesses,
  Command,
  CommandEvent,
  Prompt,
  GeminiProject,
  GeminiSessionInfo,
  GeminiMessageSummary,
} from "../shared/types";

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
  invoke(channel: "session:list-projects"): Promise<GeminiProject[]>;
  invoke(
    channel: "session:list-sessions",
    projectPaths: string[],
  ): Promise<GeminiSessionInfo[]>;
  invoke(
    channel: "session:load",
    filePath: string,
  ): Promise<GeminiMessageSummary[]>;
  invoke(
    channel: "session:message-content",
    index: number,
  ): Promise<string>;
  invoke(
    channel: "session:messages-content",
    indices: number[],
  ): Promise<string>;
  invoke(channel: "session:auto-trim"): Promise<number[]>;
  invoke(channel: "session:check-backup"): Promise<{ exists: boolean; path: string; size: number }>;
  invoke(
    channel: "session:save",
    indicesToRemove: number[],
    outputPath?: string,
  ): Promise<string>;
  writeClipboard(text: string): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;

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
    channel: string,
    listener: (...args: unknown[]) => void,
  ): () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
