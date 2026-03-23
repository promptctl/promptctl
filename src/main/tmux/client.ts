import type {
  PaneId,
  SessionId,
  TmuxPane,
  ToolKind,
  WindowId,
} from "../../shared/types";
import { tmuxExec } from "./exec";

const PANE_FORMAT = [
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

export async function discoverPanes(): Promise<TmuxPane[]> {
  const stdout = await tmuxExec(["list-panes", "-a", "-F", PANE_FORMAT]);
  return parsePaneList(stdout);
}

export async function sendKeys(
  paneId: PaneId,
  text: string,
  pressEnter = true,
): Promise<void> {
  const args = ["send-keys", "-t", paneId, text];
  if (pressEnter) args.push("Enter");
  await tmuxExec(args);
}

export async function capturePane(
  paneId: PaneId,
  startLine = -500,
  endLine = -1,
): Promise<string> {
  // -e preserves ANSI escape sequences for terminal color rendering
  return tmuxExec([
    "capture-pane",
    "-t",
    paneId,
    "-p",
    "-e",
    "-J",
    "-S",
    String(startLine),
    "-E",
    String(endLine),
  ]);
}

export async function startPipePane(
  paneId: PaneId,
  outputPath: string,
): Promise<void> {
  await tmuxExec(["pipe-pane", "-t", paneId, "-o", `cat >> ${outputPath}`]);
}

export async function stopPipePane(paneId: PaneId): Promise<void> {
  await tmuxExec(["pipe-pane", "-t", paneId]);
}

export async function launchInNewSession(
  sessionName: string,
  command: string,
  cwd: string,
): Promise<PaneId> {
  // Create session detached, running the command
  await tmuxExec([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    cwd,
    command,
  ]);
  // Get the pane ID of the new session
  const stdout = await tmuxExec([
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_id}",
  ]);
  return stdout.trim() as PaneId;
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await tmuxExec(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}
