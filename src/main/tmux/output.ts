// Output streaming via pipe-pane + file watching
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { WebContents } from "electron";
import type { PaneId, PaneOutputChunk } from "../../shared/types";
import { startPipePane, stopPipePane, capturePane } from "./client";

export type OutputListener = (paneId: PaneId, data: string) => void;

interface PaneWatcher {
  paneId: PaneId;
  filePath: string;
  pollTimer: ReturnType<typeof setInterval> | null;
  subscribers: Set<WebContents>;
  lastSize: number;
}

export class PaneOutputManager {
  private watchers = new Map<string, PaneWatcher>();
  private outputDir: string;
  private listeners = new Set<OutputListener>();

  constructor() {
    this.outputDir = join(app.getPath("userData"), "pane-output");
  }

  // Allow other subsystems (scheduler, matchers) to observe all output
  addListener(listener: OutputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async init(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  async watch(paneId: PaneId, webContents: WebContents): Promise<void> {
    const key = paneId;
    let watcher = this.watchers.get(key);

    if (watcher) {
      watcher.subscribers.add(webContents);
      const w = watcher;
      webContents.once("destroyed", () => w.subscribers.delete(webContents));
      // Send initial capture to the new subscriber
      await this.sendInitialCapture(paneId, webContents);
      return;
    }

    const filePath = join(this.outputDir, `${paneId.replace("%", "pane-")}.log`);
    // Truncate the file to start fresh
    await writeFile(filePath, "");

    watcher = {
      paneId,
      filePath,
      pollTimer: null,
      subscribers: new Set([webContents]),
      lastSize: 0,
    };
    this.watchers.set(key, watcher);

    const w = watcher;
    webContents.once("destroyed", () => w.subscribers.delete(webContents));

    // Send initial capture (current pane contents)
    await this.sendInitialCapture(paneId, webContents);

    // Start pipe-pane to stream output to file
    await startPipePane(paneId, filePath);

    // Poll the file for changes (fs.watch is unreliable on macOS)
    watcher.pollTimer = setInterval(() => this.pollFile(w), 100);
  }

  async unwatch(paneId: PaneId, webContents: WebContents): Promise<void> {
    const watcher = this.watchers.get(paneId);
    if (!watcher) return;

    watcher.subscribers.delete(webContents);

    if (watcher.subscribers.size === 0) {
      await this.teardownWatcher(paneId, watcher);
    }
  }

  async unwatchAll(): Promise<void> {
    for (const [paneId, watcher] of this.watchers) {
      await this.teardownWatcher(paneId as PaneId, watcher);
    }
  }

  private async teardownWatcher(
    paneId: PaneId,
    watcher: PaneWatcher,
  ): Promise<void> {
    if (watcher.pollTimer) clearInterval(watcher.pollTimer);
    try {
      await stopPipePane(paneId);
    } catch {
      // Pane may already be dead
    }
    this.watchers.delete(paneId);
  }

  private async sendInitialCapture(
    paneId: PaneId,
    webContents: WebContents,
  ): Promise<void> {
    try {
      const content = await capturePane(paneId, -500, -1);
      const chunk: PaneOutputChunk = {
        paneId,
        data: content,
        timestamp: Date.now(),
      };
      if (!webContents.isDestroyed()) {
        webContents.send("tmux:pane-output", chunk);
      }
    } catch {
      // Pane may not exist yet
    }
  }

  private async pollFile(watcher: PaneWatcher): Promise<void> {
    try {
      const stats = await stat(watcher.filePath);
      if (stats.size > watcher.lastSize) {
        await this.onFileChange(watcher);
      }
    } catch {
      // File may not exist yet or was removed
    }
  }

  private async onFileChange(watcher: PaneWatcher): Promise<void> {
    try {
      const content = await readFile(watcher.filePath, "utf-8");
      const newData = content.slice(watcher.lastSize);
      watcher.lastSize = content.length;

      if (newData.length === 0) return;

      const chunk: PaneOutputChunk = {
        paneId: watcher.paneId,
        data: newData,
        timestamp: Date.now(),
      };

      for (const wc of watcher.subscribers) {
        if (!wc.isDestroyed()) {
          wc.send("tmux:pane-output", chunk);
        }
      }

      // Notify listeners (scheduler idle tracking, matchers)
      for (const listener of this.listeners) {
        listener(watcher.paneId, newData);
      }
    } catch {
      // File may have been removed
    }
  }
}
