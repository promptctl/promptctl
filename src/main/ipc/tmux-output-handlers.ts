// [LAW:single-enforcer] One IPC site for the output-stream surface. The
// renderer subscribes/unsubscribes via invoke channels; the router broadcasts
// chunks and state markers to per-pane watchers. Nothing else sends
// tmux:output:chunk or tmux:output:state.
//
// [LAW:dataflow-not-control-flow] Every output chunk flows the same way:
// tmux → router → per-pane watchers. Disconnected webContents are gated by
// data (isDestroyed), not a special-case branch.

import { ipcMain } from "electron";
import type { PaneId } from "../../shared/types";
import type { TmuxOutputRouter } from "../tmux/output-router";

export function registerTmuxOutputHandlers(
  router: TmuxOutputRouter,
): () => void {
  ipcMain.handle(
    "tmux:output:subscribe",
    (event, paneId: string) => {
      router.subscribe(paneId as PaneId, event.sender);
    },
  );

  ipcMain.handle(
    "tmux:output:unsubscribe",
    (event, paneId: string) => {
      router.unsubscribe(paneId as PaneId, event.sender);
    },
  );

  return () => {
    ipcMain.removeHandler("tmux:output:subscribe");
    ipcMain.removeHandler("tmux:output:unsubscribe");
  };
}
