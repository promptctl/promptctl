// [LAW:single-enforcer] All tmux IPC goes through here.
import { ipcMain } from "electron";
import type { PaneId, ToolKind } from "../../shared/types";
import type { TmuxStateManager } from "../tmux/state";
import type { PaneOutputManager } from "../tmux/output";
import { sendKeys, sendKeysLiteral, capturePane } from "../tmux/client";
import { launchTool } from "../tmux/controllable";
import { getPaneProcesses } from "../tmux/processes";

export function registerTmuxHandlers(
  stateManager: TmuxStateManager,
  outputManager: PaneOutputManager,
): void {
  // State subscription
  ipcMain.on("tmux:subscribe", (event) => {
    stateManager.subscribe(event.sender);
  });

  ipcMain.on("tmux:unsubscribe", (event) => {
    stateManager.unsubscribe(event.sender);
  });

  // Request-response
  ipcMain.handle("tmux:snapshot", () => stateManager.getSnapshot());

  ipcMain.handle(
    "tmux:send-keys",
    (_e, paneId: string, text: string, pressEnter = true) =>
      sendKeys(paneId as PaneId, text, pressEnter),
  );

  ipcMain.handle(
    "tmux:send-keys-literal",
    (_e, paneId: string, data: string) =>
      sendKeysLiteral(paneId as PaneId, data),
  );

  ipcMain.handle(
    "tmux:capture-pane",
    (_e, paneId: string, start: number, end: number) =>
      capturePane(paneId as PaneId, start, end),
  );

  // Output streaming
  ipcMain.on("tmux:watch-pane", async (event, paneId: string) => {
    await outputManager.watch(paneId as PaneId, event.sender);
  });

  ipcMain.on("tmux:unwatch-pane", async (event, paneId: string) => {
    await outputManager.unwatch(paneId as PaneId, event.sender);
  });

  // Process info
  ipcMain.handle("tmux:pane-processes", async (_e, paneId: string) => {
    const snapshot = stateManager.getSnapshot();
    const pane = snapshot.panes.find((p) => p.id === paneId);
    if (!pane) return { paneId, panePid: 0, children: [], timestamp: Date.now() };
    const children = await getPaneProcesses(pane.pid);
    return { paneId, panePid: pane.pid, children, timestamp: Date.now() };
  });

  // Tool launching
  ipcMain.handle(
    "tmux:launch-tool",
    (_e, kind: string, sessionName: string, cwd: string) =>
      launchTool(kind as Exclude<ToolKind, "unknown">, sessionName, cwd),
  );
}
