// [LAW:single-enforcer] One IPC site for the TmuxControlConnection state
// surface. The library bridge (tmux:invoke / tmux:event) sits next to this
// in main.ts; this module owns only the promptctl-specific connection state
// channel that the debug surface and downstream UI read.
//
// [LAW:dataflow-not-control-flow] Every onConnectionState transition fans
// out the same way: forward to all live BrowserWindows. There is no branch
// on "is anyone subscribed" — disconnected webContents are skipped via the
// data check (isDestroyed), not a control-flow gate.

import { BrowserWindow, ipcMain } from "electron";
import type {
  ConnectionStateEvent,
  TmuxControlConnection,
} from "../tmux/control";
import type { SessionId } from "../../shared/types";

export function registerTmuxControlHandlers(
  connection: TmuxControlConnection,
): () => void {
  ipcMain.handle("tmux:control-state:get", (): ConnectionStateEvent =>
    connection.getState(),
  );

  // [LAW:single-enforcer] Renderer intent ("watch this pane's session") reaches
  // the connection's lone attached-session writer here. The renderer never
  // drives switch-client directly — main owns the attachment across reconnects.
  ipcMain.handle(
    "tmux:watch-session",
    (_e, sessionId: SessionId | null): Promise<void> =>
      connection.watchSession(sessionId),
  );

  const off = connection.onConnectionState((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send("tmux:control-state", event);
    }
  });

  return () => {
    ipcMain.removeHandler("tmux:control-state:get");
    ipcMain.removeHandler("tmux:watch-session");
    off();
  };
}
