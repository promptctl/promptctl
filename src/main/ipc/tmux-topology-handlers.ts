// [LAW:single-enforcer] One IPC site for the topology surface. The renderer
// reads it via the get-channel for cold start and the broadcast channel for
// updates; nothing else fans out topology snapshots.
//
// [LAW:dataflow-not-control-flow] Every snapshot flows the same way:
// tracker → fan-out to every live BrowserWindow. Disconnected webContents
// are gated by data (isDestroyed), not a special-case branch.

import { BrowserWindow, ipcMain } from "electron";
import type { TmuxSnapshot } from "../../shared/types";
import type { TmuxTopologyTracker } from "../tmux/topology";

export function registerTmuxTopologyHandlers(
  tracker: TmuxTopologyTracker,
): () => void {
  ipcMain.handle("tmux:topology:get", (): TmuxSnapshot => tracker.snapshot());

  const off = tracker.onSnapshot((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send("tmux:topology", snapshot);
    }
  });

  return () => {
    ipcMain.removeHandler("tmux:topology:get");
    off();
  };
}
