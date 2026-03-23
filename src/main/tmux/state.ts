// [LAW:one-source-of-truth] Main process owns tmux state. Renderer is a projection.
import type { WebContents } from "electron";
import type { TmuxSnapshot } from "../../shared/types";
import { discoverPanes } from "./client";

export class TmuxStateManager {
  private snapshot: TmuxSnapshot = { timestamp: 0, panes: [] };
  private interval: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<WebContents>();
  private lastJson = "";

  start(intervalMs = 2000): void {
    this.refresh();
    this.interval = setInterval(() => this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  subscribe(webContents: WebContents): void {
    this.subscribers.add(webContents);
    webContents.once("destroyed", () => this.subscribers.delete(webContents));
    // Send current state immediately
    webContents.send("tmux:snapshot", this.snapshot);
  }

  unsubscribe(webContents: WebContents): void {
    this.subscribers.delete(webContents);
  }

  getSnapshot(): TmuxSnapshot {
    return this.snapshot;
  }

  private async refresh(): Promise<void> {
    try {
      const panes = await discoverPanes();
      const snapshot: TmuxSnapshot = { timestamp: Date.now(), panes };
      const json = JSON.stringify(panes);

      // Only broadcast if state actually changed
      if (json !== this.lastJson) {
        this.lastJson = json;
        this.snapshot = snapshot;
        this.broadcast();
      }
    } catch {
      // tmux not running or command failed — set empty state
      const empty: TmuxSnapshot = { timestamp: Date.now(), panes: [] };
      if (this.lastJson !== "[]") {
        this.lastJson = "[]";
        this.snapshot = empty;
        this.broadcast();
      }
    }
  }

  private broadcast(): void {
    for (const wc of this.subscribers) {
      if (!wc.isDestroyed()) {
        wc.send("tmux:snapshot", this.snapshot);
      }
    }
  }
}
