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

// [LAW:locality-or-seam] The router consumes tmux through two methods —
// execute() for scrollback capture and setPaneAction() for pause/resume.
// The router does NOT branch on "is there a client right now" — it asks
// for the work; the connection routes to a client or rejects loudly. The
// rejection-vs-success distinction becomes data the caller catches and
// logs, not a control-flow gate.
export interface OutputRouterDeps {
  onEvent<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void;
  onConnectionState(listener: (s: ConnectionStateEvent) => void): () => void;
  execute(command: string): Promise<CommandResponse>;
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;
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
    // [LAW:single-enforcer] Bytes-on-the-wire. xterm.js is the only byte→text
    // decoder. A TextDecoder here would (a) double-decode (xterm decodes too)
    // and (b) fragment cross-chunk UTF-8 sequences into U+FFFD / latin1
    // mojibake — pane output frames split bytes at arbitrary offsets.
    // [LAW:dataflow-not-control-flow] Same shape every chunk; the bytes
    // decide what the consumer sees, not any branching here.
    this.sendToPane(paneId, "tmux:output:chunk", { paneId, data });
  }

  private handlePause = (msg: { paneId: number }): void => {
    const paneId = `%${msg.paneId}` as PaneId;
    this.sendState(paneId, "paused");
    // Auto-resume: the debug surface doesn't need backpressure.
    // pause-after=2 requires a continue command to resume output.
    void this.deps
      .setPaneAction(msg.paneId, PaneAction.Continue)
      .catch((err) => {
        console.error(
          `[output-router] auto-resume failed for pane %${msg.paneId}:`,
          err,
        );
      });
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

  private sendToPane(paneId: PaneId, channel: string, payload: unknown): void {
    const entries = this.watchers.get(paneId);
    if (entries === undefined || entries.size === 0) return;
    for (const entry of entries) {
      if (!entry.wc.isDestroyed()) {
        entry.wc.send(channel, payload);
      }
    }
  }

  private async captureScrollback(paneId: PaneId): Promise<void> {
    const resp = await this.deps
      .execute(`capture-pane -t ${paneId} -p -e -J -S -500`)
      .catch((err) => {
        // The mesh is empty (no sessions yet) or the call raced a disconnect.
        // Surface the rejection — the next ready transition or onSnapshot
        // re-trigger will reissue the capture.
        console.error(
          `[output-router] capture-pane for ${paneId} failed:`,
          err,
        );
        return null;
      });
    if (resp === null || !resp.success) return;
    // [LAW:one-source-of-truth] `resp.output` lines arrive as Latin-1-byte-
    // faithful strings — the library's command-response contract (transport
    // reads tmux stdout with setEncoding('latin1') so each JS code unit is
    // exactly one byte). Invert that mapping to recover the raw bytes so the
    // wire format matches the live %output path; shipping the string as-is
    // would let the renderer treat each byte as a Unicode codepoint and emit
    // latin1 mojibake for any non-ASCII content in scrollback.
    const text = resp.output.join("\n");
    const data = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 0xff;
    this.sendToPane(paneId, "tmux:output:chunk", { paneId, data });
    this.sendState(paneId, "streaming");
  }
}
