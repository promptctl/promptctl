// [LAW:single-enforcer] One IPC site for the two pane-scoped operations
// that the renderer still calls into main for:
//
//  - `tmux:pane-processes`: read OS-level child processes of a pane PID
//    (`pgrep -P` + `ps`). Pane PID comes from the topology tracker —
//    the canonical snapshot source post-77e.1.9.
//
//  - `tmux:launch-tool`: spawn a tool binary in a fresh tmux session via
//    the control-mode connection's TmuxClient. Replaces the legacy
//    `launchInNewSession` shellout in src/main/tmux/controllable.ts.
//
// [LAW:one-source-of-truth] Both handlers route through dep-injected
// surfaces (`getSnapshot`, `getClient`) so reconnect state lives in the
// TmuxControlConnection — not duplicated here.

import { ipcMain } from "electron";
import type { TmuxClient } from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import type {
  PaneId,
  PaneProcesses,
  TmuxSnapshot,
  ToolKind,
} from "../../shared/types";
import { getPaneProcesses } from "../tmux/processes";

export interface TmuxPaneHandlersDeps {
  readonly getSnapshot: () => TmuxSnapshot;
  // [LAW:no-defensive-null-guards] Client is null between disconnect and
  // reconnect-ready. The handler surfaces that to the renderer as an
  // error string — `launch-tool` is a user-initiated action with a
  // visible error path in LaunchToolDialog, so loud failure is correct.
  readonly getClient: () => TmuxClient | null;
}

const TOOL_BINARIES: Record<Exclude<ToolKind, "unknown">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

export function registerTmuxPaneHandlers(
  deps: TmuxPaneHandlersDeps,
): () => void {
  ipcMain.handle(
    "tmux:pane-processes",
    async (_e, paneId: PaneId): Promise<PaneProcesses> => {
      // [LAW:locality-or-seam] The renderer IPC contract declares this channel's
      // argument as PaneId; the handler honors that brand rather than re-casting
      // a raw wire string.
      const snapshot = deps.getSnapshot();
      const pane = snapshot.panes.find((p) => p.id === paneId);
      if (!pane) {
        return { paneId, panePid: 0, children: [], timestamp: Date.now() };
      }
      const children = await getPaneProcesses(pane.pid);
      return {
        paneId,
        panePid: pane.pid,
        children,
        timestamp: Date.now(),
      };
    },
  );

  ipcMain.handle(
    "tmux:launch-tool",
    async (
      _e,
      kind: string,
      sessionName: string,
      cwd: string,
    ): Promise<PaneId> => {
      const toolKind = kind as Exclude<ToolKind, "unknown">;
      const binary = TOOL_BINARIES[toolKind];
      if (!binary) {
        throw new Error(`Unknown tool kind: ${kind}`);
      }
      const client = deps.getClient();
      if (client === null) {
        throw new Error(
          "tmux control connection is not ready — try again in a moment",
        );
      }

      // tmux's `has-session -t =NAME` returns success when the named session
      // exists; we reject the launch to avoid colliding with an existing
      // session. The `=` prefix forces exact-name match.
      const hasResp = await client.execute(
        `has-session -t =${tmuxEscape(sessionName)}`,
      );
      if (hasResp.success) {
        throw new Error(`tmux session "${sessionName}" already exists`);
      }

      const createResp = await client.execute(
        [
          "new-session",
          "-d",
          "-s",
          tmuxEscape(sessionName),
          "-c",
          tmuxEscape(cwd),
          tmuxEscape(binary),
        ].join(" "),
      );
      if (!createResp.success) {
        throw new Error(
          `Failed to launch ${binary}: ${createResp.output.join("\n")}`,
        );
      }

      const listResp = await client.execute(
        `list-panes -t ${tmuxEscape(sessionName)} -F "#{pane_id}"`,
      );
      if (!listResp.success || listResp.output.length === 0) {
        throw new Error(
          `Launched ${binary} in session "${sessionName}" but could not resolve pane id`,
        );
      }
      return listResp.output[0].trim() as PaneId;
    },
  );

  return () => {
    ipcMain.removeHandler("tmux:pane-processes");
    ipcMain.removeHandler("tmux:launch-tool");
  };
}
