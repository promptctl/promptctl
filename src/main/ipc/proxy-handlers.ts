// [LAW:single-enforcer] All proxy IPC routes through here.
// Subscribers register their WebContents via "proxy:subscribe"; we relay
// every ProxyEvent and every ProxyStatus change to the renderer.
import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";

import { proxyManager } from "../proxy";
import { proxyEventBus } from "../proxy/events";
import { loadSettings } from "../settings/store";
import type { ClientInfo, ProxyEvent } from "../../shared/proxy-events";

const subscribers = new Set<WebContents>();

// Single bus subscription forwards to all renderer subscribers — avoids one
// EventEmitter listener per subscriber (which would cap out at maxListeners).
let busUnsub: (() => void) | null = null;
let clientUnsub: (() => void) | null = null;

function ensureBusSubscription(): void {
  if (busUnsub === null) {
    busUnsub = proxyEventBus.subscribe((event: ProxyEvent) => {
      for (const wc of subscribers) {
        if (!wc.isDestroyed()) wc.send("proxy:event", event);
      }
    });
  }
  if (clientUnsub === null) {
    clientUnsub = proxyEventBus.subscribeClients((info: ClientInfo) => {
      for (const wc of subscribers) {
        if (!wc.isDestroyed()) wc.send("proxy:client", info);
      }
    });
  }
}

function broadcastStatus(): void {
  const status = proxyManager.status();
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send("proxy:status", status);
  }
}

export function registerProxyHandlers(): void {
  ensureBusSubscription();

  ipcMain.on("proxy:subscribe", (event) => {
    const wc = event.sender;
    subscribers.add(wc);
    wc.once("destroyed", () => subscribers.delete(wc));
    // Send current status immediately so the renderer can paint without a
    // separate invoke.
    wc.send("proxy:status", proxyManager.status());
    wc.send("proxy:clients", proxyManager.listClients());
  });

  ipcMain.on("proxy:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });

  ipcMain.handle("proxy:status", () => proxyManager.status());
  ipcMain.handle("proxy:list-clients", () => proxyManager.listClients());

  ipcMain.handle("proxy:load-har", async (_e, filePath: string) => {
    const status = await proxyManager.loadHar(filePath);
    broadcastStatus();
    return status;
  });

  // Open the OS file picker rooted at the recordings dir. Returns the chosen
  // path or null if the user cancelled. Lives in main because the renderer
  // can't open dialogs directly.
  ipcMain.handle("proxy:pick-har", async (event) => {
    const settings = await loadSettings();
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOpts = {
      title: "Resume from HAR file",
      defaultPath: settings.proxyRecordingsDir,
      filters: [
        { name: "HAR files", extensions: ["har"] },
        { name: "All files", extensions: ["*"] },
      ],
      properties: ["openFile" as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
