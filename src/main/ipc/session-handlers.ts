// [LAW:single-enforcer] All session editor IPC goes through here.
import { ipcMain } from "electron";
import type {
  ProviderKind,
  CompressToolsOptions,
  Pipeline,
} from "../../shared/types";
import {
  listAllProjects,
  getAllProviderMetadata,
  loadSession,
  listSessions,
  findSession,
  getMessageContent,
  getMessageRaw,
  getMessagesContent,
  autoTrimSuggestions,
  saveSession,
  compressToolResults,
  listVersions,
  undo,
  redo,
  restoreVersion,
  diffVersions,
  searchSessions,
  peekSession,
  applyPipeline,
  getActiveProvider,
} from "../sessions/editor";
import {
  getAnalyzer,
  getAnalyzerMetadata,
} from "../sessions/analyzers/registry";
import { runTask } from "../tasks/runner";

export function registerSessionHandlers(): void {
  // Discovery: aggregate across all registered providers
  ipcMain.handle("session:list-projects", () => listAllProjects());

  // Provider metadata for the renderer (badge, typeStyles, flagDefinitions, helpText)
  ipcMain.handle("session:provider-metadata", () => getAllProviderMetadata());

  // List sessions for a specific project — provider routes to correct adapter
  ipcMain.handle(
    "session:list-sessions",
    (_e, provider: ProviderKind, projectPaths: string[]) =>
      listSessions(provider, projectPaths),
  );

  // Load: sets active adapter, then loads session
  ipcMain.handle(
    "session:load",
    (_e, provider: ProviderKind, filePath: string) =>
      loadSession(provider, filePath),
  );

  // Locate a session by id across the provider's project dirs. Powers the
  // promptctl://open?provider=&sessionId= deep link.
  ipcMain.handle(
    "session:find",
    (_e, provider: ProviderKind, sessionId: string) =>
      findSession(provider, sessionId),
  );

  // All remaining handlers delegate to the active adapter via coordinator
  ipcMain.handle("session:message-content", (_e, index: number) =>
    getMessageContent(index),
  );

  // Structured renderer surface — returns the parsed JS object, not a string.
  // [LAW:one-source-of-truth] Single fetch path per message; the renderer
  // never re-parses JSON.
  ipcMain.handle("session:message-raw", (_e, index: number) =>
    getMessageRaw(index),
  );

  ipcMain.handle("session:messages-content", (_e, indices: number[]) =>
    getMessagesContent(indices),
  );

  ipcMain.handle("session:auto-trim", () => autoTrimSuggestions());

  ipcMain.handle(
    "session:save",
    (_e, indicesToRemove: number[], outputPath?: string, force?: boolean) =>
      saveSession(indicesToRemove, outputPath, force ?? false),
  );

  ipcMain.handle(
    "session:compress-tools",
    (_e, taskId: string, indices: number[], options: CompressToolsOptions) =>
      runTask(
        taskId,
        {
          kind: "compress-tools",
          label: `Compressing ${indices.length} tool result${indices.length === 1 ? "" : "s"}`,
          total: indices.length,
        },
        (handle) => compressToolResults(indices, options, handle),
      ),
  );

  // Full-text content search across all provider storage roots (via ripgrep).
  // Total=0: the operation doesn't have a bounded work count; progress messages
  // carry the running match/session counts in their `message` field.
  // Streams results incrementally on "session:search-batch" (per invoking
  // window only — no need to broadcast to every window) so the UI can render
  // results as enrichment completes instead of waiting for all 2k+ sessions.
  ipcMain.handle("session:search", (event, taskId: string, query: string) =>
    runTask(
      taskId,
      { kind: "search", label: `Searching: "${query}"`, total: 0 },
      (handle) =>
        searchSessions(query, handle, (batch) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("session:search-batch", {
              taskId,
              results: batch,
            });
          }
        }),
    ),
  );

  // Stateless peek — load a session's messages WITHOUT marking it as active.
  // Used by the search panel preview, which must not clobber whatever session
  // is currently being edited. See peekSession in editor.ts.
  ipcMain.handle(
    "session:peek",
    (_e, provider: ProviderKind, filePath: string) =>
      peekSession(provider, filePath),
  );

  // Analyzers — list metadata for the provider, run a specific analyzer by id,
  // apply a pipeline. Analyzer metadata is keyed by provider so the renderer
  // only sees analyzers that apply to the current session's provider.
  ipcMain.handle("session:list-analyzers", (_e, provider: ProviderKind) =>
    getAnalyzerMetadata(provider),
  );
  ipcMain.handle(
    "session:run-analyzer",
    (_e, analyzerId: string, filePath: string) => {
      const analyzer = getAnalyzer(analyzerId);
      // [LAW:single-enforcer] Verify the analyzer applies to the active
      // session's provider. session:list-analyzers is provider-scoped, so
      // the renderer never *requests* a mismatched analyzer in practice —
      // but the IPC surface should enforce the same invariant in case a
      // stale invocation lands after the user switched providers, or any
      // other consumer ever calls this directly.
      const activeProvider = getActiveProvider();
      if (analyzer.providerId !== activeProvider) {
        throw new Error(
          `Analyzer ${analyzerId} is scoped to provider ${analyzer.providerId}, but active session uses ${activeProvider}`,
        );
      }
      return analyzer.run(filePath);
    },
  );
  ipcMain.handle(
    "session:apply-pipeline",
    (_e, pipeline: Pipeline, force?: boolean) =>
      applyPipeline(pipeline, force ?? false),
  );

  // Versioning
  ipcMain.handle("session:list-versions", () => listVersions());
  ipcMain.handle("session:undo", () => undo());
  ipcMain.handle("session:redo", () => redo());
  ipcMain.handle("session:restore-version", (_e, idx: number) =>
    restoreVersion(idx),
  );
  ipcMain.handle(
    "session:diff-versions",
    (_e, fromIdx: number, toIdx: number) => diffVersions(fromIdx, toIdx),
  );
}
