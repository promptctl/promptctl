// [LAW:single-enforcer] Task control surface is exactly this file.
// Renderer cancels via invoke; main emits progress via webContents.send on
// TASK_EVENT_CHANNEL (handled inside runTask).
import { ipcMain } from "electron";
import { cancelTask } from "../tasks/runner";

export function registerTaskHandlers(): void {
  ipcMain.handle("task:cancel", (_e, taskId: string): boolean =>
    cancelTask(taskId),
  );
}
