// [LAW:single-enforcer] All command IPC goes through here.
import { ipcMain } from "electron";
import type { Command } from "../../shared/types";
import type { CommandEngine } from "../command/engine";
import { saveCommands } from "../command/persistence";

export function registerCommandHandlers(engine: CommandEngine): void {
  ipcMain.on("command:subscribe", (event) => {
    engine.subscribe(event.sender);
  });

  ipcMain.handle("command:list", () => engine.getCommands());

  ipcMain.handle("command:add", async (_e, command: Command) => {
    engine.addCommand(command);
    await saveCommands(engine.getCommands());
  });

  ipcMain.handle("command:remove", async (_e, id: string) => {
    engine.removeCommand(id);
    await saveCommands(engine.getCommands());
  });

  ipcMain.handle(
    "command:update",
    async (_e, id: string, updates: Partial<Command>) => {
      engine.updateCommand(id, updates);
      await saveCommands(engine.getCommands());
    },
  );

  ipcMain.handle("command:fire", async (_e, id: string) => {
    await engine.fireCommand(id);
    await saveCommands(engine.getCommands());
  });
}
