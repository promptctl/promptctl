// [LAW:one-source-of-truth] One format string for the entire app's pane
// queries. TmuxTopologyTracker formats list-panes with it and parses the
// response through `parsePaneList`; nothing else in the app constructs a
// per-pane tmux format. Keep field order in `PANE_FORMAT` aligned with
// the parse offsets in `parsePaneList` — they're a single contract.

import type {
  PaneId,
  SessionId,
  TmuxPane,
  ToolKind,
  WindowId,
} from "../../shared/types";

export const PANE_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{session_id}",
  "#{window_name}",
  "#{window_id}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join("\t");

export function detectToolKind(command: string): ToolKind {
  const lower = command.toLowerCase();
  if (lower === "claude" || lower.includes("claude-code")) return "claude";
  if (lower === "codex" || lower.includes("codex")) return "codex";
  if (lower === "gemini" || lower.includes("gemini")) return "gemini";
  return "unknown";
}

export function parsePaneList(stdout: string): TmuxPane[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      const currentCommand = fields[8] ?? "";
      return {
        id: (fields[0] ?? "") as PaneId,
        sessionName: fields[1] ?? "",
        sessionId: (fields[2] ?? "") as SessionId,
        windowName: fields[3] ?? "",
        windowId: (fields[4] ?? "") as WindowId,
        windowIndex: parseInt(fields[5] ?? "0", 10),
        paneIndex: parseInt(fields[6] ?? "0", 10),
        pid: parseInt(fields[7] ?? "0", 10),
        currentCommand,
        currentPath: fields[9] ?? "",
        width: parseInt(fields[10] ?? "0", 10),
        height: parseInt(fields[11] ?? "0", 10),
        active: fields[12] === "1",
        toolKind: detectToolKind(currentCommand),
      };
    });
}
