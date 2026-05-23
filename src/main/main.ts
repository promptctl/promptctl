import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMainBridge } from "tmux-control-mode-js/electron/main";
import { TmuxControlConnection } from "./tmux/control";
import { ownedSessionName } from "./tmux/session";
import { TmuxTopologyTracker } from "./tmux/topology";
import { CommandEngine } from "./command/engine";
import { loadCommands } from "./command/persistence";
import { LaunchRegistry } from "./launch/registry";
import { loadLaunches, saveLaunches } from "./launch/persistence";
import { startLaunchCorrelator } from "./launch/correlator";
import { recoverLaunches } from "./launch/recovery";
import { registerLaunchHandlers } from "./ipc/launch-handlers";
import { registerTmuxControlHandlers } from "./ipc/tmux-control-handlers";
import { registerTmuxTopologyHandlers } from "./ipc/tmux-topology-handlers";
import { TmuxOutputRouter } from "./tmux/output-router";
import { registerTmuxOutputHandlers } from "./ipc/tmux-output-handlers";
import { registerTmuxPaneHandlers } from "./ipc/tmux-pane-handlers";
import { registerCommandHandlers } from "./ipc/command-handlers";
import type { PaneId, SessionId } from "../shared/types";
import { registerSessionHandlers } from "./ipc/session-handlers";
import { registerPromptHandlers } from "./ipc/prompt-handlers";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerLlmHandlers } from "./ipc/llm-handlers";
import { registerTaskHandlers } from "./ipc/task-handlers";
import { registerProxyHandlers } from "./ipc/proxy-handlers";
import { proxyManager, shutdownProxy } from "./proxy";
import { loadSettings } from "./settings/store";
import { registerProvider } from "./sessions/registry";
import { geminiAdapter } from "./sessions/gemini/adapter";
import { claudeAdapter } from "./sessions/claude/adapter";
import { findPromptctlUrlInArgv, promptctlUrlToHash } from "./deep-link";
import {
  startDeepLinkServer,
  stopDeepLinkServer,
} from "./deep-link-server";
import type { Server } from "node:http";

// Handle Squirrel events for Windows installer
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require("electron-squirrel-startup")) {
  app.quit();
}

// Expose Chrome DevTools Protocol on a TCP port in dev mode so external tools
// (MCP electron debuggers, CI harnesses) can drive the renderer. Must be set
// before app.whenReady(). No effect in packaged builds.
if (process.defaultApp) {
  const cdpPort = process.env.PROMPTCTL_CDP_PORT ?? "48599";
  app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
  // Write the port to a discovery file; writeFileSync is fine here — we're
  // still in module-init before whenReady, and the file is tiny.
  try {
    const file = path.join(os.homedir(), ".promptctl", "cdp-port");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cdpPort, "utf-8");
    console.log(`[deep-link] CDP enabled on port ${cdpPort} (port file: ${file})`);
  } catch (err) {
    console.log(`[deep-link] CDP port file write failed: ${err}`);
  }
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// [LAW:one-source-of-truth] The TmuxControlConnection is the single producer
// of tmux server state and the single channel through which the rest of the
// app drives tmux (send-keys, execute, capture-pane). The legacy polling
// stack (state.ts / output.ts / client.ts / exec.ts / controllable.ts) is
// gone as of 77e.1.9.
//
// The session name is derived deterministically from the install path, so two
// instances of the same install co-attach to the same session and different
// installs (dev + prod) get different names without collision.
// PROMPTCTL_TMUX_SESSION overrides the derived name — used by e2e tests to
// pin a known target, and available to power users who want a custom name.
const TMUX_SESSION_NAME =
  process.env.PROMPTCTL_TMUX_SESSION ?? ownedSessionName(app.getAppPath());
const tmuxControl = TmuxControlConnection.start({
  sessionName: TMUX_SESSION_NAME,
});
tmuxControl.onConnectionState((ev) => {
  console.log(
    `[tmux-control] ${ev.status}${ev.reason ? `: ${ev.reason}` : ""}`,
  );
});

// [LAW:dataflow-not-control-flow] Bridge presence is a pure projection of the
// connection's status: while `ready`, a bridge wraps the current TmuxClient;
// otherwise the slot is free. The same state machine drives every transition,
// so reconnects swap the underlying client without leaking handlers.
//
// The bridge holds a direct TmuxClient reference and forbids double-registration
// on ipcMain (WeakSet guard inside the library), so we install/dispose in lock-
// step with the connection's client lifecycle.
let tmuxBridge: { dispose(): void } | null = null;
tmuxControl.onConnectionState((ev) => {
  if (ev.status === "ready" && tmuxBridge === null) {
    const client = tmuxControl.client;
    if (client !== null) {
      tmuxBridge = createMainBridge(client, ipcMain);
    }
    return;
  }
  if (ev.status !== "ready" && tmuxBridge !== null) {
    tmuxBridge.dispose();
    tmuxBridge = null;
  }
});

// [LAW:one-source-of-truth] Single tracker per process; the IPC handler
// fans its snapshots out to every renderer.
const tmuxTopology = new TmuxTopologyTracker({
  onEvent: (event, handler) => tmuxControl.on(event, handler),
  onConnectionState: (listener) => tmuxControl.onConnectionState(listener),
  getClient: () => tmuxControl.client,
});
const tmuxOutputRouter = new TmuxOutputRouter({
  onEvent: (event, handler) => tmuxControl.on(event, handler),
  onConnectionState: (listener) => tmuxControl.onConnectionState(listener),
  getClient: () => tmuxControl.client,
});

// [LAW:single-enforcer] The connection's follower mesh is a projection of
// the topology: any FOREIGN session promptctl sees in the pane list grows a
// follower that delivers its %output. Without this, only the owned-session
// pane stream is live and CommandEngine output-pattern triggers in foreign
// sessions silently pause.
//
// [LAW:no-mode-explosion] The owned session is excluded by name at the
// wiring site: the primary client already attaches there via argv, so adding
// a follower for the same session would double-deliver %output. The
// "owned vs foreign" distinction is data the call site has (TMUX_SESSION_NAME
// vs pane.sessionName), so the filter belongs here rather than as a special
// case inside the connection.
tmuxTopology.onSnapshot((snapshot) => {
  const sessions = new Set<SessionId>();
  for (const pane of snapshot.panes) {
    if (pane.sessionName === TMUX_SESSION_NAME) continue;
    sessions.add(pane.sessionId);
  }
  tmuxControl.observeSessions(sessions);
});

// [LAW:one-source-of-truth] Sole authoritative source of launch identity.
// Module-scope so subsystems wired below (proxy client-identity in 77e.4,
// topology subscriptions in later 77e.3 slices) can reference it without
// passing handles through every constructor. Initialized inside whenReady
// after persisted rows are loaded — until then the variable is null.
let launchRegistry: LaunchRegistry | null = null;

// [LAW:locality-or-seam] CommandEngine consumes tmux through three method
// surfaces; this adapter is the seam between the engine and the singleton
// control connection. No tmux imports inside CommandEngine — the type is
// the only thing it knows.
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const toPaneId = (n: number): PaneId => `%${n}` as PaneId;
const commandEngine = new CommandEngine({
  onOutput: (handler) => {
    const offOutput = tmuxControl.on("output", (msg) =>
      handler(toPaneId(msg.paneId), utf8Decoder.decode(msg.data)),
    );
    const offExtended = tmuxControl.on("extended-output", (msg) =>
      handler(toPaneId(msg.paneId), utf8Decoder.decode(msg.data)),
    );
    return () => {
      offOutput();
      offExtended();
    };
  },
  sendKeys: async (target, keys) => {
    const client = tmuxControl.client;
    if (client === null) {
      throw new Error("tmux control connection is not ready");
    }
    const resp = await client.sendKeys(target, keys);
    if (!resp.success) {
      throw new Error(`send-keys failed: ${resp.output.join("\n")}`);
    }
  },
  execute: async (command) => {
    const client = tmuxControl.client;
    if (client === null) {
      throw new Error("tmux control connection is not ready");
    }
    const resp = await client.execute(command);
    if (!resp.success) {
      throw new Error(`tmux command failed: ${resp.output.join("\n")}`);
    }
  },
});
let deepLinkServer: Server | null = null;

// [LAW:one-source-of-truth] The URL IS the selection; cold-start bakes the hash
// into the initial loadURL/loadFile, warm-path updates location.hash. Both paths
// flow through the same renderer code (useSearchParams in SessionsPage).
let pendingDeepLinkHash: string | null = null;

// Single-instance lock — second `open promptctl://…` spawns a fresh Electron
// that must relay its argv to the running one and quit. On macOS this also
// covers dev mode, where macOS launches a new stock Electron rather than
// delivering open-url to the running instance (the running Electron.app's
// bundle id is the generic `com.github.Electron`).
if (!app.requestSingleInstanceLock()) {
  console.log("[deep-link] secondary instance — quitting");
  app.quit();
}

// setAsDefaultProtocolClient registration:
//  - packaged: 1-arg form; macOS routes via Info.plist
//  - dev (`electron .`): 3-arg form so macOS relaunches us as
//    `<execPath> <app-root> <url>` — otherwise it runs bare Electron.app
//    and the user sees the stock welcome window.
if (process.defaultApp && process.argv.length >= 2) {
  const appRoot = path.resolve(process.argv[1]);
  app.setAsDefaultProtocolClient("promptctl", process.execPath, [appRoot]);
  console.log(
    `[deep-link] registered promptctl:// (dev mode) execPath=${process.execPath} appRoot=${appRoot}`,
  );
} else {
  app.setAsDefaultProtocolClient("promptctl");
  console.log("[deep-link] registered promptctl:// (packaged mode)");
}

// macOS delivers open-url via the 'open-url' event. It can fire before whenReady,
// so buffer until the window exists.
app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log(`[deep-link] open-url event: ${url}`);
  handleDeepLink(url);
});

// second-instance fires on all platforms when a second app instance relays
// its argv before quitting under the single-instance lock. In dev mode on
// macOS, this is the path URL dispatches actually take — `open-url` alone
// isn't enough because LaunchServices launches a new process.
app.on("second-instance", (_event, argv) => {
  console.log(`[deep-link] second-instance argv=${JSON.stringify(argv)}`);
  const url = findPromptctlUrlInArgv(argv);
  if (url) handleDeepLink(url);
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function handleDeepLink(url: string): void {
  const hash = promptctlUrlToHash(url);
  console.log(`[deep-link] handleDeepLink url=${url} hash=${hash}`);
  if (!hash) return;
  const [win] = BrowserWindow.getAllWindows();
  if (win && !win.webContents.isLoading()) {
    console.log(`[deep-link] updating running window to ${hash}`);
    win.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(hash)};`,
    );
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    console.log(`[deep-link] buffering hash (window not ready): ${hash}`);
    pendingDeepLinkHash = hash;
  }
}

const createWindow = (): void => {
  // Cold-start URL may come from argv (Linux/Windows) or from a buffered
  // open-url event (macOS fired before whenReady).
  const argvUrl = findPromptctlUrlInArgv(process.argv);
  const initialHash =
    pendingDeepLinkHash ??
    (argvUrl ? promptctlUrlToHash(argvUrl) : null) ??
    "";
  pendingDeepLinkHash = null;
  console.log(
    `[deep-link] createWindow argv=${JSON.stringify(process.argv)} initialHash=${JSON.stringify(initialHash)}`,
  );

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
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL + initialHash);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      initialHash ? { hash: initialHash.slice(1) } : undefined,
    );
  }
};

app.whenReady().then(async () => {
  // Initialize subsystems
  registerProvider(geminiAdapter);
  registerProvider(claudeAdapter);

  // Launch registry: load persisted rows, construct the registry, register
  // IPC handlers. The proxy starts further down — it needs the registry to
  // exist so header-based attribution (77e.4) can consult it on the first
  // request. [LAW:one-source-of-truth]
  const persistedLaunches = await loadLaunches();
  launchRegistry = new LaunchRegistry({
    initial: persistedLaunches,
    save: saveLaunches,
  });
  // [LAW:single-enforcer] Bridge tmux observation → registry mutation.
  // Snapshots feed pid correlation and exit detection (pane-cmd revert,
  // pane vanish); window-close / unlinked-window-close events feed the
  // direct exit signal. Recovery-on-restart runs separately just below.
  startLaunchCorrelator({
    registry: launchRegistry,
    onTopologySnapshot: (listener) => tmuxTopology.onSnapshot(listener),
    getTopologySnapshot: () => tmuxTopology.snapshot(),
    onTmuxEvent: (event, handler) => tmuxControl.on(event, handler),
    onConnectionState: (listener) => tmuxControl.onConnectionState(listener),
  });
  registerLaunchHandlers({
    registry: launchRegistry,
    spawn: {
      topology: tmuxTopology,
      getClient: () => tmuxControl.client,
      // [LAW:one-source-of-truth] Proxy port comes from the proxy manager
      // at call time — settings are the canonical input but the actual
      // listening port can differ (e.g. when the configured port was
      // already in use and the proxy fell back).
      getProxyPort: () => proxyManager.status().port,
    },
  });

  // [LAW:single-enforcer] Reconcile persisted launch rows against the OS
  // process table. Tools still alive keep their identity; tools that
  // exited while promptctl was down get marked exited. Fire-and-forget:
  // takes a beat to walk N processes, no point gating the rest of
  // startup on it (the registry's mutations broadcast as they land).
  void recoverLaunches({ registry: launchRegistry }).catch((err) => {
    console.error("[launch] recovery failed:", err);
  });

  registerTmuxControlHandlers(tmuxControl);
  registerTmuxTopologyHandlers(tmuxTopology);
  registerTmuxOutputHandlers(tmuxOutputRouter);
  registerTmuxPaneHandlers({
    getSnapshot: () => tmuxTopology.snapshot(),
  });
  registerCommandHandlers(commandEngine);
  registerSessionHandlers();
  registerPromptHandlers();
  registerSettingsHandlers();
  registerLlmHandlers();
  registerTaskHandlers();
  registerProxyHandlers();

  // Auto-start the proxy. HAR file is lazy-created on the first response
  // — until then, no file appears on disk. Settings drive port/target/dir.
  const settings = await loadSettings();
  try {
    await proxyManager.start({
      port: settings.proxyPort,
      upstreamTarget: settings.proxyTarget,
      recordingsDir: settings.proxyRecordingsDir,
      // Header-based attribution: launches we spawned carry
      // `X-Promptctl-Launch: <id>`; the proxy reads that, hands the
      // id to the registry, and gets a deterministic ClientInfo.
      // [LAW:single-enforcer] one identity source per direction.
      resolveLaunch: (id) => launchRegistry?.get(id) ?? null,
    });
    console.log(
      `[proxy] listening on 127.0.0.1:${proxyManager.status().port} -> ${settings.proxyTarget}`,
    );
  } catch (err) {
    console.error("[proxy] failed to auto-start:", err);
  }

  deepLinkServer = await startDeepLinkServer(handleDeepLink);

  // Start command engine on the control-mode output stream (matchers + idle).
  commandEngine.start();

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
  commandEngine.stop();
  if (tmuxBridge !== null) {
    tmuxBridge.dispose();
    tmuxBridge = null;
  }
  tmuxTopology.dispose();
  tmuxOutputRouter.dispose();
  tmuxControl.close();
  await shutdownProxy();
  if (deepLinkServer) {
    await stopDeepLinkServer(deepLinkServer);
    deepLinkServer = null;
  }
});
