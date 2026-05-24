// [LAW:one-source-of-truth] The TmuxTopologyTracker is the event-driven
// producer of pane/window/session state in the new control-mode path. It
// runs alongside src/main/tmux/state.ts (TmuxStateManager polling) until
// the cutover slice retires the legacy module; both observe the same tmux
// server, only the legacy stack still drives Loops today.
//
// [LAW:single-enforcer] Every snapshot mutation flows through the same two
// merge sites: refreshPanes() (full re-list on topology change) and
// onSubChange() (per-field patch). External callers see one read surface
// (snapshot()) and one subscription (onSnapshot()). Diff/broadcast happens
// in exactly one place.
//
// [LAW:dataflow-not-control-flow] The tracker runs a fixed pipeline on
// every event: receive → resolve which scope (pane / window / session) →
// patch via registry → diff-gate → broadcast. There is no branch that
// "skips" the broadcast or the merge — variability lives in the data
// (subscription name, scope id, value). Even disconnect is data: ready→
// not-ready clears the map and broadcasts an empty snapshot via the same
// path.
//
// [LAW:no-defensive-null-guards] Client null is a real lifecycle state
// (between disconnect and reconnect-ready), so the few null checks here
// are at the trust boundary with the connection — the alternative would
// be queuing commands that fire after a transient failure, which is
// strictly worse than dropping them and letting the next ready-transition
// re-list from scratch.

import type { TmuxEventMap } from "tmux-control-mode-js";
import type {
  CommandResponse,
  SubscriptionChangedMessage,
} from "tmux-control-mode-js/protocol";
import { detectToolKind, PANE_FORMAT, parsePaneList } from "./pane-parse";
import type { ConnectionStateEvent } from "./control";
import type {
  PaneId,
  SessionId,
  TmuxPane,
  TmuxSnapshot,
  WindowId,
} from "../../shared/types";

// [LAW:one-source-of-truth] §2.1 of docs/tmux-integration-plan.md — the
// canonical subscription table. Adding/removing a row here is the only place
// the tracker's data shape changes.
export const TOPOLOGY_SUBSCRIPTIONS: readonly {
  readonly name: string;
  readonly what: string;
  readonly format: string;
}[] = [
  { name: "pane-cmd", what: "%*", format: "#{pane_current_command}" },
  { name: "pane-cwd", what: "%*", format: "#{pane_current_path}" },
  { name: "pane-pid", what: "%*", format: "#{pane_pid}" },
  { name: "pane-active", what: "%*", format: "#{pane_active}" },
  { name: "pane-size", what: "%*", format: "#{pane_width}x#{pane_height}" },
  { name: "window-name", what: "@*", format: "#{window_name}" },
  { name: "session-name", what: "(s)", format: "#{session_name}" },
];

// [LAW:dataflow-not-control-flow] One canonical set; every entry triggers
// the same refresh-from-list-panes path. tmux 3.6 emits a different mix of
// these per operation (split → window-pane-changed; new-window/kill-window
// → unlinked-window-{add,close} + session-window-changed; renames →
// unlinked-window-renamed). Listening to the union keeps the tracker
// version-agnostic and the diff-gate suppresses no-op refreshes.
const TOPOLOGY_EVENTS = [
  "window-add",
  "window-close",
  "window-pane-changed",
  "window-renamed",
  "layout-change",
  "session-window-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
] as const satisfies readonly (keyof TmuxEventMap)[];

// [LAW:locality-or-seam] The tracker consumes tmux through two operations
// — execute() for the periodic list-panes refresh, subscribeRaw() for the
// pane/window/session field subscriptions. Both route through the
// connection's mesh-aware dispatch; the tracker never inspects which
// underlying client serviced a request.
export interface TopologyDeps {
  // Reconnect-safe event subscription. In production this is
  // TmuxControlConnection.on, which classifies events by name and routes
  // them to the appropriate client(s) in the mesh.
  onEvent<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void;
  // Notification on every connection-state transition (and once immediately
  // with the current state).
  onConnectionState(listener: (s: ConnectionStateEvent) => void): () => void;
  // Run a tmux command. Rejects loudly when the mesh is empty (the
  // no-sessions case); the tracker logs and waits for the next ready
  // transition rather than retrying blindly.
  execute(command: string): Promise<CommandResponse>;
  // Register a sticky topology subscription. The connection re-issues it
  // automatically when the topology-source role transfers between clients,
  // so the tracker subscribes once and never re-subscribes itself.
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;
}

export type TopologyListener = (snapshot: TmuxSnapshot) => void;

// [LAW:one-type-per-behavior] Pane-scoped subscription updates all patch a
// TmuxPane in the same shape: (pane, value) → next pane. The registry below
// is the only site that knows which field maps to which subscription name.
type PanePatcher = (pane: TmuxPane, value: string) => TmuxPane;

const PANE_PATCHERS: Record<string, PanePatcher> = {
  "pane-cmd": (p, v) => ({
    ...p,
    currentCommand: v,
    toolKind: detectToolKind(v),
  }),
  "pane-cwd": (p, v) => ({ ...p, currentPath: v }),
  "pane-pid": (p, v) => ({ ...p, pid: parseInt(v, 10) || 0 }),
  "pane-active": (p, v) => ({ ...p, active: v === "1" }),
  "pane-size": (p, v) => {
    const [w, h] = v.split("x");
    return {
      ...p,
      width: parseInt(w ?? "0", 10) || 0,
      height: parseInt(h ?? "0", 10) || 0,
    };
  },
};

export class TmuxTopologyTracker {
  private panes = new Map<PaneId, TmuxPane>();
  private listeners = new Set<TopologyListener>();
  private disposers: (() => void)[] = [];
  // JSON of the panes array (timestamp excluded) — the diff-gate signature.
  private lastBroadcastJson = "[]";
  // Increments on every refresh so a late-completing list-panes from a prior
  // ready cycle doesn't overwrite a newer one.
  private refreshGeneration = 0;

  constructor(private readonly deps: TopologyDeps) {
    this.disposers.push(deps.onConnectionState(this.handleConnState));
    this.disposers.push(
      deps.onEvent("subscription-changed", this.handleSubscriptionChanged),
    );
    for (const ev of TOPOLOGY_EVENTS) {
      this.disposers.push(deps.onEvent(ev, this.handleTopologyEvent));
    }
  }

  snapshot(): TmuxSnapshot {
    return { timestamp: Date.now(), panes: [...this.panes.values()] };
  }

  onSnapshot(listener: TopologyListener): () => void {
    listener(this.snapshot());
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.listeners.clear();
    this.panes.clear();
  }

  private subscriptionsRegistered = false;

  private handleConnState = (state: ConnectionStateEvent): void => {
    if (state.status === "ready") {
      void this.onReady();
      return;
    }
    // Not-ready (connecting / no-sessions / closed): the topology is
    // unknown or empty. Broadcast an empty snapshot so the renderer reflects
    // the gap honestly.
    if (this.panes.size === 0) return;
    this.panes = new Map();
    this.broadcast();
  };

  private onReady = async (): Promise<void> => {
    // [LAW:single-enforcer] Subscriptions register once; the connection
    // re-applies them across topology-source transitions. The flag flips
    // to true only when every subscribe call resolves with success — a
    // {success: false} response (tmux rejected the subscribe shape) does
    // NOT consume the one-shot, so the next ready transition retries.
    // safeAwait returns null on thrown errors, which is also a non-success.
    if (!this.subscriptionsRegistered) {
      const results = await Promise.all(
        TOPOLOGY_SUBSCRIPTIONS.map((sub) =>
          safeAwait(
            this.deps.subscribeRaw(sub.name, sub.what, sub.format),
            `subscribe(${sub.name})`,
          ),
        ),
      );
      const allSucceeded = results.every((r) => r !== null && r.success);
      if (allSucceeded) this.subscriptionsRegistered = true;
    }
    await this.refreshPanes();
  };

  private handleTopologyEvent = (): void => {
    void this.refreshPanes();
  };

  private async refreshPanes(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const resp = await safeAwait(
      this.deps.execute(`list-panes -a -F "${PANE_FORMAT}"`),
      "list-panes",
    );
    if (resp === null || !resp.success) return;
    if (generation !== this.refreshGeneration) return;
    const stdout = resp.output.join("\n");
    const allPanes = parsePaneList(stdout);
    this.panes = new Map(allPanes.map((p) => [p.id, p] as const));
    this.broadcast();
  }

  private handleSubscriptionChanged = (
    msg: SubscriptionChangedMessage,
  ): void => {
    // Pane-scoped patch: a known field on a known pane.
    const patcher = PANE_PATCHERS[msg.name];
    if (patcher !== undefined && msg.paneId !== -1) {
      const id = paneIdOf(msg.paneId);
      const pane = this.panes.get(id);
      if (pane === undefined) return;
      const next = patcher(pane, msg.value);
      if (paneEqual(pane, next)) return;
      this.panes.set(id, next);
      this.broadcast();
      return;
    }
    // Window-scoped: rename ripples through every pane in the window.
    if (msg.name === "window-name" && msg.windowId !== -1) {
      this.patchManyByWindow(windowIdOf(msg.windowId), (p) => ({
        ...p,
        windowName: msg.value,
      }));
      return;
    }
    // Session-scoped: rename ripples through every pane in the session.
    if (msg.name === "session-name" && msg.sessionId !== -1) {
      this.patchManyByContainer(
        sessionIdOf(msg.sessionId),
        (p) => p.sessionId,
        (p) => ({ ...p, sessionName: msg.value }),
      );
      return;
    }
  };

  private patchManyByWindow(
    windowId: WindowId,
    patcher: (pane: TmuxPane) => TmuxPane,
  ): void {
    let changed = false;
    for (const [id, pane] of this.panes) {
      if (pane.windowId !== windowId) continue;
      const next = patcher(pane);
      if (paneEqual(pane, next)) continue;
      this.panes.set(id, next);
      changed = true;
    }
    if (changed) this.broadcast();
  }

  private patchManyByContainer(
    containerId: SessionId | WindowId,
    select: (p: TmuxPane) => SessionId | WindowId,
    patcher: (pane: TmuxPane) => TmuxPane,
  ): void {
    let changed = false;
    for (const [id, pane] of this.panes) {
      if (select(pane) !== containerId) continue;
      const next = patcher(pane);
      if (paneEqual(pane, next)) continue;
      this.panes.set(id, next);
      changed = true;
    }
    if (changed) this.broadcast();
  }

  private broadcast(): void {
    const panes = [...this.panes.values()];
    const json = JSON.stringify(panes);
    if (json === this.lastBroadcastJson) return;
    this.lastBroadcastJson = json;
    const snapshot: TmuxSnapshot = { timestamp: Date.now(), panes };
    for (const listener of this.listeners) listener(snapshot);
  }
}

function paneIdOf(n: number): PaneId {
  return `%${n}` as PaneId;
}

function windowIdOf(n: number): WindowId {
  return `@${n}` as WindowId;
}

function sessionIdOf(n: number): SessionId {
  return `$${n}` as SessionId;
}

function paneEqual(a: TmuxPane, b: TmuxPane): boolean {
  return (
    a.id === b.id &&
    a.sessionName === b.sessionName &&
    a.sessionId === b.sessionId &&
    a.windowName === b.windowName &&
    a.windowId === b.windowId &&
    a.windowIndex === b.windowIndex &&
    a.paneIndex === b.paneIndex &&
    a.pid === b.pid &&
    a.currentCommand === b.currentCommand &&
    a.currentPath === b.currentPath &&
    a.width === b.width &&
    a.height === b.height &&
    a.active === b.active &&
    a.toolKind === b.toolKind
  );
}

// Wraps a command Promise so a transient failure (e.g. transport drop racing
// the call) is logged and returns null instead of throwing through the
// tracker. The next ready transition re-lists from scratch — this is the
// correct response to a race; it is *not* generic error swallowing.
// Persistent failures (a malformed format string, a permanent tmux error)
// surface through the log every cycle and are observable.
async function safeAwait<T>(p: Promise<T>, label: string): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tmux-topology] ${label} failed: ${message}`);
    return null;
  }
}
