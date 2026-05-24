// [LAW:single-enforcer] One IPC site for the pane-scoped operation the
// renderer still calls into main for:
//
//  - `tmux:pane-processes`: read OS-level child processes of a pane PID
//    (`pgrep -P` + `ps`). Pane PID comes from the topology tracker —
//    the canonical snapshot source post-77e.1.9.
//
// The legacy `tmux:launch-tool` channel was retired in 77e.3.6: it was
// the un-tagged spawn that produced anonymous panes. The launch
// registry (launch:create) replaces it — every spawn now flows through
// LaunchRegistry and carries identity through env + header + pane
// subscription. [LAW:one-source-of-truth] one spawn path.

import { ipcMain } from "electron";
import type { PaneId, PaneProcesses, TmuxSnapshot } from "../../shared/types";
import { getPaneProcesses } from "../tmux/processes";

export interface TmuxPaneHandlersDeps {
  readonly getSnapshot: () => TmuxSnapshot;
}

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

  return () => {
    ipcMain.removeHandler("tmux:pane-processes");
  };
}
