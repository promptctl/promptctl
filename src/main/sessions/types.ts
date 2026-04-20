// [LAW:one-type-per-behavior] All providers implement this single interface.
// Designed for JSONL-native formats (Claude Code). Simpler formats (Gemini JSON)
// are the degenerate case where logical index === physical index.
import type {
  ProviderKind,
  ProviderUIMetadata,
  Project,
  SessionInfo,
  MessageSummary,
  DiffEntry,
  CompressToolsOptions,
  CompressToolsResult,
} from "../../shared/types";
import type { TaskHandle } from "../tasks/runner";

export interface ProviderAdapter {
  readonly id: ProviderKind;
  readonly uiMetadata: ProviderUIMetadata;

  // Discovery
  listProjects(): Promise<Project[]>;
  listSessions(projectPaths: string[]): Promise<SessionInfo[]>;
  // Locate a session by id without materializing every project/session.
  // Returns the owning project alongside its SessionInfo, or null if not found.
  // Used by deep-link handling (promptctl://open?provider=...&sessionId=...).
  findSession(
    sessionId: string,
  ): Promise<{ project: Project; session: SessionInfo } | null>;

  // Loading — adapter parses its format and returns uniform MessageSummary[].
  // For JSONL formats, adapter internally tracks logical→physical line mapping.
  loadSession(filePath: string): Promise<MessageSummary[]>;
  getMessageContent(index: number): string;
  getMessagesContent(indices: number[]): string;
  // Raw parsed line — the JS object the adapter parsed from the source file.
  // Renderers that want structured access (field-grid views) consume this
  // instead of re-parsing the stringified content. [LAW:one-source-of-truth]
  getMessageRaw(index: number): unknown;

  // Analysis
  autoTrimSuggestions(): number[];

  // Tool result compression — threshold-based dispatch does truncate or summarize
  // per item, so the UI exposes a single operation. TaskHandle is optional only
  // so provider stubs in tests can skip it; main paths always pass one.
  compressToolResults?(
    indices: number[],
    options: CompressToolsOptions,
    handle?: TaskHandle,
  ): Promise<CompressToolsResult>;

  // Stateless summarization of arbitrary content — does NOT touch loaded adapter state.
  // Used for token counting on disk content without disrupting in-memory edits.
  summarizeContent(content: string): MessageSummary[];

  // Diff — adapter parses its own format and produces semantic diff entries.
  diffContent(oldContent: string, newContent: string): DiffEntry[];

  // Persistence — adapter handles format-specific save (JSON rewrite vs JSONL line removal).
  // indicesToRemove are logical indices; adapter translates to physical as needed.
  saveSession(
    indicesToRemove: number[],
    outputPath?: string,
  ): Promise<string>;
}
