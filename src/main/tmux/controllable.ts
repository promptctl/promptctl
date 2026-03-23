import type { PaneId, ToolKind, TmuxPane } from "../../shared/types";
import { launchInNewSession, hasSession } from "./client";

const TOOL_BINARIES: Record<Exclude<ToolKind, "unknown">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

export function toolBinary(kind: ToolKind): string | null {
  if (kind === "unknown") return null;
  return TOOL_BINARIES[kind];
}

// A shell prompt (waiting for input) means the pane is idle from the tool perspective
const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash"]);

export function isIdle(pane: TmuxPane): boolean {
  // If the current command is a shell, the tool has exited or hasn't started
  if (SHELL_COMMANDS.has(pane.currentCommand)) return true;
  // If the tool is running, we consider it "busy" — idle detection
  // based on output patterns is handled by the scheduler's idle trigger
  return false;
}

export async function launchTool(
  kind: Exclude<ToolKind, "unknown">,
  sessionName: string,
  cwd: string,
): Promise<PaneId> {
  const binary = TOOL_BINARIES[kind];

  // Avoid session name collisions
  if (await hasSession(sessionName)) {
    throw new Error(`tmux session "${sessionName}" already exists`);
  }

  return launchInNewSession(sessionName, binary, cwd);
}
