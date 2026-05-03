// [LAW:one-source-of-truth] The TmuxOutputRouter is the sole producer of
// pane-output byte streams in the new control-mode path. It runs alongside
// src/main/tmux/output.ts (PaneOutputManager) until the cutover slice retires
// the legacy module; both observe the same tmux server, only the legacy stack
// still drives Loops today.
//
// [LAW:single-enforcer] Every output chunk and state marker for a watched pane
// flows through this router. Outside callers subscribe/unsubscribe via IPC;
// the router manages per-pane watcher sets and scrollback capture.
//
// [LAW:dataflow-not-control-flow] The router runs the same sequence for every
// output event: receive → lookup watchers → broadcast. Variability lives in
// the data (which pane, which watchers), not in control flow. The pause/continue
// auto-resume follows the same pattern: receive → broadcast state → resume.

import type { TmuxEventMap } from "tmux-control-mode-js";
import type { CommandResponse } from "tmux-control-mode-js/protocol";
import { PaneAction } from "tmux-control-mode-js/protocol";
import type { ConnectionStateEvent } from "./control";
import type { PaneId } from "../../shared/types";

export interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface OutputRouterClient {
  execute(command: string): Promise<CommandResponse>;
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;
}

export interface OutputRouterDeps {
  onEvent<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void;
  onConnectionState(
    listener: (s: ConnectionStateEvent) => void,
  ): () => void;
  getClient(): OutputRouterClient | null;
}

interface WatcherEntry {
  readonly wc: WebContentsLike;
  readonly onDestroyed: () => void;
}

export class TmuxOutputRouter {
  private readonly watchers = new Map<PaneId, Set<WatcherEntry>>();
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly deps: OutputRouterDeps) {
    this.disposers.push(
      deps.onEvent("output", (msg) => this.onPaneOutput(msg.paneId, msg.data)),
    );
    this.disposers.push(
      deps.onEvent("extended-output", (msg) =>
        this.onPaneOutput(msg.paneId, msg.data),
      ),
    );
    this.disposers.push(deps.onEvent("pause", this.handlePause));
    this.disposers.push(deps.onEvent("continue", this.handleContinue));
    this.disposers.push(deps.onConnectionState(this.handleConnState));
  }

  subscribe(paneId: PaneId, wc: WebContentsLike): void {
    const set = this.watchers.get(paneId);
    const isFirst = set === undefined || set.size === 0;
    const entries = set ?? new Set<WatcherEntry>();
    if (set === undefined) this.watchers.set(paneId, entries);

    const onDestroyed = (): void => this.removeEntry(paneId, entry);
    const entry: WatcherEntry = { wc, onDestroyed };
    entries.add(entry);
    wc.once("destroyed", onDestroyed);

    if (isFirst) {
      void this.captureScrollback(paneId);
    }
  }

  unsubscribe(paneId: PaneId, wc: WebContentsLike): void {
    const entries = this.watchers.get(paneId);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.wc === wc) {
        this.removeEntry(paneId, entry);
        return;
      }
    }
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    for (const entries of this.watchers.values()) {
      for (const entry of entries) {
        entry.wc.removeListener("destroyed", entry.onDestroyed);
      }
    }
    this.watchers.clear();
  }

  private removeEntry(paneId: PaneId, entry: WatcherEntry): void {
    const entries = this.watchers.get(paneId);
    if (entries === undefined) return;
    entries.delete(entry);
    entry.wc.removeListener("destroyed", entry.onDestroyed);
    if (entries.size === 0) this.watchers.delete(paneId);
  }

  private onPaneOutput(paneIdNum: number, data: Uint8Array): void {
    const paneId = `%${paneIdNum}` as PaneId;
    this.sendToPane(paneId, "tmux:output:chunk", {
      paneId,
      data: new TextDecoder("utf-8", { fatal: false }).decode(data),
    });
  }

  private handlePause = (msg: { paneId: number }): void => {
    const paneId = `%${msg.paneId}` as PaneId;
    this.sendState(paneId, "paused");
    // Auto-resume: the debug surface doesn't need backpressure.
    // pause-after=2 requires a continue command to resume output.
    const client = this.deps.getClient();
    if (client !== null) {
      void client
        .setPaneAction(msg.paneId, PaneAction.Continue)
        .catch(
          // [LAW:no-defensive-null-guards] Swallow is intentional: if the
          // pane is gone or the client is closing, there's nothing to do.
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
        );
    }
  };

  private handleContinue = (msg: { paneId: number }): void => {
    const paneId = `%${msg.paneId}` as PaneId;
    this.sendState(paneId, "streaming");
  };

  private handleConnState = (state: ConnectionStateEvent): void => {
    if (state.status === "ready") {
      // Re-capture scrollback for any panes that still have watchers
      // after a reconnect.
      for (const paneId of this.watchers.keys()) {
        void this.captureScrollback(paneId);
      }
      return;
    }
    // Not-ready: broadcast disconnected for every watched pane.
    for (const paneId of this.watchers.keys()) {
      this.sendState(paneId, "disconnected");
    }
  };

  private sendState(
    paneId: PaneId,
    state: "streaming" | "paused" | "disconnected",
  ): void {
    this.sendToPane(paneId, "tmux:output:state", { paneId, state });
  }

  private sendToPane(
    paneId: PaneId,
    channel: string,
    payload: unknown,
  ): void {
    const entries = this.watchers.get(paneId);
    if (entries === undefined || entries.size === 0) return;
    for (const entry of entries) {
      if (!entry.wc.isDestroyed()) {
        entry.wc.send(channel, payload);
      }
    }
  }

  private async captureScrollback(paneId: PaneId): Promise<void> {
    const client = this.deps.getClient();
    if (client === null) return;
    const resp = await client.execute(
      `capture-pane -t ${paneId} -p -e -J -S -500`,
    );
    if (!resp.success) return;
    const text = resp.output.join("\n");
    this.sendToPane(paneId, "tmux:output:chunk", { paneId, data: text });
    this.sendState(paneId, "streaming");
  }
}
