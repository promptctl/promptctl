// [LAW:single-enforcer] All settings IPC goes through here.
import { ipcMain } from "electron";
import type { AppSettings } from "../settings/store";
import { loadSettings, saveSettings } from "../settings/store";

export function registerSettingsHandlers(): void {
  ipcMain.handle("settings:load", () => loadSettings());

  ipcMain.handle(
    "settings:save",
    (_e, updates: Partial<AppSettings>) => saveSettings(updates),
  );
}
