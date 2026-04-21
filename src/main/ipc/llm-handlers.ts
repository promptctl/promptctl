// [LAW:single-enforcer] All LLM operation IPC goes through here.
// Every handler runs inside runTask so cancel + progress work uniformly.
import { ipcMain } from "electron";
import type { MessageSummary } from "../../shared/types";
import { suggestCompression, segmentTopics } from "../llm/operations";
import type { CompressSuggestion, TopicSegment } from "../llm/operations";
import { runTask } from "../tasks/runner";
import { countTokens as anthropicCountTokens } from "../llm/anthropic-count";

export function registerLlmHandlers(): void {
  // Test connectivity for the Anthropic count_tokens endpoint. Free to call;
  // used by the Settings page's "Test Connection" button to verify the key.
  ipcMain.handle("anthropic:test-count-tokens", async (): Promise<{
    ok: boolean;
    tokens?: number;
    error?: string;
  }> => {
    try {
      const tokens = await anthropicCountTokens({
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true, tokens };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "llm:suggest-compression",
    (
      _e,
      taskId: string,
      messages: MessageSummary[],
    ): Promise<CompressSuggestion[]> =>
      runTask(
        taskId,
        { kind: "smart-compress", label: "Analyzing conversation", total: 2 },
        (handle) => suggestCompression(messages, handle),
      ),
  );

  ipcMain.handle(
    "llm:segment-topics",
    (
      _e,
      taskId: string,
      messages: MessageSummary[],
      focusQuery: string,
    ): Promise<TopicSegment[]> => {
      const query = focusQuery.trim();
      const label = query.length > 0
        ? `Finding "${query}"`
        : "Segmenting conversation into topics";
      return runTask(
        taskId,
        { kind: "topic-focus", label, total: 2 },
        (handle) => segmentTopics(messages, focusQuery, handle),
      );
    },
  );
}
