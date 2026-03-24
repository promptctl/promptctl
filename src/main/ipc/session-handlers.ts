// [LAW:single-enforcer] All session editor IPC goes through here.
import { ipcMain } from "electron";
import { listProjects, listSessions } from "../sessions/discovery";
import {
  loadSession,
  getMessageContent,
  getMessagesContent,
  autoTrimSuggestions,
  checkBackupExists,
  saveSession,
} from "../sessions/editor";

export function registerSessionHandlers(): void {
  ipcMain.handle("session:list-projects", () => listProjects());

  ipcMain.handle("session:list-sessions", (_e, projectPaths: string[]) =>
    listSessions(projectPaths),
  );

  ipcMain.handle("session:load", (_e, filePath: string) =>
    loadSession(filePath),
  );

  ipcMain.handle("session:message-content", (_e, index: number) =>
    getMessageContent(index),
  );

  ipcMain.handle("session:messages-content", (_e, indices: number[]) =>
    getMessagesContent(indices),
  );

  ipcMain.handle("session:auto-trim", () => autoTrimSuggestions());

  ipcMain.handle("session:check-backup", () => checkBackupExists());

  ipcMain.handle(
    "session:save",
    (_e, indicesToRemove: number[], outputPath?: string) =>
      saveSession(indicesToRemove, outputPath),
  );
}
