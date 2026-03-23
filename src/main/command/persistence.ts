import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { app } from "electron";
import type { Command } from "../../shared/types";

function commandsPath(): string {
  return join(app.getPath("userData"), "commands.json");
}

export async function loadCommands(): Promise<Command[]> {
  try {
    const content = await readFile(commandsPath(), "utf-8");
    return JSON.parse(content) as Command[];
  } catch {
    return [];
  }
}

export async function saveCommands(commands: Command[]): Promise<void> {
  const path = commandsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(commands, null, 2));
}
