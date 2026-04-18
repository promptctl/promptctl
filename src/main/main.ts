import { app, BrowserWindow } from "electron";
import path from "node:path";
import { TmuxStateManager } from "./tmux/state";
import { PaneOutputManager } from "./tmux/output";
import { CommandEngine } from "./command/engine";
import { loadCommands } from "./command/persistence";
import { registerTmuxHandlers } from "./ipc/tmux-handlers";
import { registerCommandHandlers } from "./ipc/command-handlers";
import { registerSessionHandlers } from "./ipc/session-handlers";
import { registerPromptHandlers } from "./ipc/prompt-handlers";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerLlmHandlers } from "./ipc/llm-handlers";
import { registerTaskHandlers } from "./ipc/task-handlers";
import { registerProvider } from "./sessions/registry";
import { geminiAdapter } from "./sessions/gemini/adapter";
import { claudeAdapter } from "./sessions/claude/adapter";

// Handle Squirrel events for Windows installer
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require("electron-squirrel-startup")) {
  app.quit();
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const tmuxState = new TmuxStateManager();
const outputManager = new PaneOutputManager();
const commandEngine = new CommandEngine(tmuxState);

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Log renderer console to main process stdout (skip Electron noise)
  mainWindow.webContents.on("console-message", (e) => {
    if (e.message.includes("Electron Security Warning")) return;
    console.log(`[renderer:${e.level}] ${e.message}`);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(async () => {
  // Initialize subsystems
  registerProvider(geminiAdapter);
  registerProvider(claudeAdapter);
  registerTmuxHandlers(tmuxState, outputManager);
  registerCommandHandlers(commandEngine);
  registerSessionHandlers();
  registerPromptHandlers();
  registerSettingsHandlers();
  registerLlmHandlers();
  registerTaskHandlers();

  await outputManager.init();
  tmuxState.start();

  // Start command engine on output stream (handles both matchers and idle tracking)
  commandEngine.start(outputManager);

  // Restore persisted commands
  const savedCommands = await loadCommands();
  commandEngine.loadCommands(savedCommands);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  tmuxState.stop();
  commandEngine.stop();
  await outputManager.unwatchAll();
});
