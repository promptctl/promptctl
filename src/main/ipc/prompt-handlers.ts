// [LAW:single-enforcer] All prompt IPC goes through here.
import { ipcMain } from "electron";
import type { Prompt } from "../../shared/types";
import { loadPrompts, savePrompt, deletePrompt } from "../prompt/persistence";

export function registerPromptHandlers(): void {
  ipcMain.handle("prompt:list", () => loadPrompts());

  ipcMain.handle("prompt:save", async (_e, prompt: Prompt) => {
    await savePrompt(prompt);
    return loadPrompts();
  });

  ipcMain.handle("prompt:delete", async (_e, filename: string) => {
    await deletePrompt(filename);
    return loadPrompts();
  });
}
