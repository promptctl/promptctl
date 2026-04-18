// [LAW:single-enforcer] All LLM operation IPC goes through here.
// Every handler runs inside runTask so cancel + progress work uniformly.
import { ipcMain } from "electron";
import type { MessageSummary } from "../../shared/types";
import { suggestCompression, segmentTopics } from "../llm/operations";
import type { CompressSuggestion, TopicSegment } from "../llm/operations";
import { runTask } from "../tasks/runner";

export function registerLlmHandlers(): void {
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
