// [LAW:types-are-the-program] The mesh's type is the program:
//   clients: Map<SessionId, TmuxClient>   — the entire mesh, one entry per
//                                            attached session, all entries
//                                            structurally identical
//   topologySourceId: SessionId | null    — role designation; a value that
//                                            shifts as sessions come and go
//   ownedSessionIds: Set<SessionId>       — narrow operational property read
//                                            ONLY by close() to clean up
//                                            sessions promptctl created
//
// No primary/follower split. No privileged element. Sessions are sessions.
// The "is this owned" property is a flag the cleanup path reads, not a shape
// the rest of the code branches on. Every consumer of the connection sees a
// uniform mesh — same operations, same events, same code path per session.
//
// [LAW:one-source-of-truth] One Map for the mesh. Membership is the only
// authoritative record of "which sessions we observe." Two structures
// carrying overlapping membership information would drift; the first commit
// that adds a session through one path and forgets to update the other is
// the bug this design forbids by construction.
//
// [LAW:dataflow-not-control-flow] The connection runs one reconcile pipeline
// — enumerate sessions, diff against the mesh, spawn for new ids, drop for
// gone ids — on every trigger (initial connect, periodic poll, client exit).
// Variability lives in the data (which ids appeared/disappeared); the
// pipeline runs identically every invocation.
//
// [LAW:single-enforcer] close() is the only reader of ownedSessionIds. No
// other code path branches on whether a session was promptctl-created. The
// cleanup obligation is a narrow seam local to lifecycle code; widening it
// past this boundary is the malignancy the new ticket explicitly rejects.
//
// [LAW:no-defensive-null-guards] "No sessions exist" is a real expressible
// state (status: "no-sessions") that the type carries honestly. Writes
// against an empty mesh fail loudly rather than being papered over by a
// defensive fallback to a privileged element — there IS no privileged
// element, and the explicit failure is information the caller surfaces.

import {
  TmuxClient,
  spawnTmux,
  type ConnectionState,
  type SplitOptions,
  type TmuxEventMap,
  type TmuxTransport,
} from "tmux-control-mode-js";
import type {
  CommandResponse,
  PaneAction,
} from "tmux-control-mode-js/protocol";
import type { SessionId } from "../../shared/types";
import { TmuxError, tmuxExec } from "./exec";

// The library emits these synthetic envelopes alongside parsed tmux messages
// through the wildcard channel. They are not exported from the package root
// (see node_modules/tmux-control-mode-js/dist/index.d.ts), so we define the
// compatible shapes locally — the bridge consumes them structurally.
interface ConnectionStateMessage {
  readonly type: "connection-state";
  readonly state: ConnectionState;
}

// EmitterMessage is the wildcard envelope: parsed tmux messages plus the
// synthetic lifecycle types above. We use `unknown` at the call boundary so
// callers (notably the library bridge cast through `as TmuxClient`) keep
// structural compatibility without us re-deriving the full union.
type EmitterMessage = unknown;

// [LAW:one-type-per-behavior] Connection status is one enum that carries the
// full lifecycle. `no-sessions` is not an error or transient — it's a
// legitimate state where tmux exists but no sessions are observed yet.
export type ConnectionStatus =
  | "connecting"
  | "ready"
  | "no-sessions"
  | "closed";

export interface ConnectionStateEvent {
  readonly status: ConnectionStatus;
  readonly reason?: string;
  // Reconnect counter is data on every event so the debug surface renders
  // every transition the same way — no branch on "is this a reconnect."
  readonly reconnectAttempts: number;
  // Number of sessions currently observed. Data, not a separate type:
  // consumers that care about the mesh size read it from the event.
  readonly observedSessions: number;
}

export interface TmuxControlConnectionOptions {
  // tmux -L socket path; defaults to PROMPTCTL_TMUX_SOCKET env var or null.
  readonly socketPath?: string | null;
  // Test seam: produce a TmuxTransport for a given session id. Default
  // spawns `tmux attach-session -t <sessionId>` (optionally with -L socket).
  readonly transportFactory?: (sessionId: SessionId) => TmuxTransport;
  // Test seam: enumerate existing tmux session ids. Default shells out
  // through tmuxExec and parses #{session_id}.
  readonly enumerateSessions?: () => Promise<SessionId[]>;
  // Reconcile cadence while connection is live. Default 2000ms — picks up
  // sessions created externally without depending on any specific tmux
  // event being emitted for session creation.
  readonly reconcileIntervalMs?: number;
  // Initial connect failure backoff. Default 2000ms.
  readonly reconnectDelayMs?: number;
}

// [LAW:dataflow-not-control-flow] The classifier is data: a Set the on() path
// consults to decide whether to fan a handler across the whole mesh or
// attach it once to the topology source. The session-scoped set covers
// every event tmux emits on a per-attached-session basis:
//
//   - output / extended-output / pause / continue: pane-level i/o, only
//     emitted by the client attached to that pane's session.
//   - subscription-changed: tmux emits these per-client too — a
//     `refresh-client -B name:%pane:format` subscription fires whenever
//     the pane's value updates, but only on the client whose attached
//     session contains that pane. Fanning across the mesh ensures we
//     receive subscription updates for every pane in every session,
//     not just the topology source's.
//
// Every other event is server-wide and attached once to the topology
// source for dedup.
const SESSION_SCOPED_EVENTS = new Set<keyof TmuxEventMap>([
  "output",
  "extended-output",
  "pause",
  "continue",
  "subscription-changed",
]);

// All events the connection synthesizes itself. Bridge or other consumers
// listening via on("*", ...) get the connection-level lifecycle, not the
// per-client events of any one underlying client — a per-client exit is not
// "the connection died," it's "one session went away."
const SYNTHETIC_EVENTS = new Set<string>([
  "connection-state",
  "reconnected",
  "exit",
]);

// The wildcard fan-out attaches to every tmux event type the connection knows
// about. Per-client synthetic events (connection-state, reconnected, exit) are
// excluded because the connection synthesizes its own; including them would
// double-deliver. Listed here once so the on("*") path stays in sync with
// what we expose individually.
const WILDCARD_FANOUT_EVENTS: readonly (keyof TmuxEventMap)[] = [
  // Session-scoped
  "output",
  "extended-output",
  "pause",
  "continue",
  // Server-scoped
  "begin",
  "end",
  "error",
  "pane-mode-changed",
  "window-add",
  "window-close",
  "window-renamed",
  "window-pane-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
  "layout-change",
  "session-changed",
  "session-renamed",
  "sessions-changed",
  "session-window-changed",
  "client-session-changed",
  "client-detached",
  "paste-buffer-changed",
  "paste-buffer-deleted",
  "subscription-changed",
  "message",
  "config-error",
];

interface RegisteredListener {
  readonly event: keyof TmuxEventMap | "*";
  readonly handler: (ev: unknown) => void;
  readonly scope: "session-scoped" | "server-scoped" | "synthetic";
  // For "*" listeners we hold the per-event unsubscribes synthesized at
  // attach time so off() can tear them all down.
  readonly children?: (() => void)[];
}

interface RegisteredSubscription {
  readonly name: string;
  readonly what: string;
  readonly format: string;
}

type StateListener = (event: ConnectionStateEvent) => void;

export class TmuxControlConnection {
  private static instance: TmuxControlConnection | null = null;

  private readonly socketPath: string | null;
  private readonly transportFactory: (sessionId: SessionId) => TmuxTransport;
  private readonly enumerateSessions: () => Promise<SessionId[]>;
  private readonly reconcileIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly stateListeners = new Set<StateListener>();

  // [LAW:one-source-of-truth] The mesh.
  private readonly clients = new Map<SessionId, TmuxClient>();
  // [LAW:dataflow-not-control-flow] Role designation; a value, not a type.
  private topologySourceId: SessionId | null = null;
  // [LAW:single-enforcer] Read by close() alone.
  private readonly ownedSessionIds = new Set<SessionId>();
  // [LAW:locality-or-seam] Pane-to-session tracker. tmux's per-client
  // setPaneAction (refresh-client -A) is meaningful only on the client
  // whose attached session contains the pane — every other client's view
  // of "this pane" is decorative. We learn the mapping from %output events
  // (each pane's session id == the emitting client's session id) and use
  // it to route setPaneAction to the right client. Without this, pause/
  // resume cycles target the wrong client and output stalls.
  private readonly paneSessions = new Map<number, SessionId>();

  // [LAW:one-source-of-truth] Sticky registrations re-applied across
  // (re)spawns and topology-source transitions.
  private readonly listeners: RegisteredListener[] = [];
  private readonly subscriptions = new Map<string, RegisteredSubscription>();

  private status: ConnectionStatus = "connecting";
  private statusReason: string | undefined;
  private reconnectAttempts = 0;
  private closed = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileInFlight = false;
  private reconcileScheduled = false;

  private readyResolve: () => void = () => undefined;
  private readonly _ready: Promise<void>;

  private constructor(options: TmuxControlConnectionOptions) {
    this.socketPath =
      options.socketPath ?? process.env.PROMPTCTL_TMUX_SOCKET ?? null;
    this.transportFactory =
      options.transportFactory ??
      ((sessionId) => {
        // [LAW:single-enforcer] All default-path transport spawns route
        // through here so each session's client is consistently created
        // with `attach-session -t <sessionId>` — the session id (`$N`) is
        // a stable handle tmux can target across reconnects, unlike a
        // session name which the user can rename out from under us.
        const args = ["attach-session", "-t", sessionId];
        return this.socketPath === null
          ? spawnTmux(args)
          : spawnTmux(args, { socketPath: this.socketPath });
      });
    this.enumerateSessions =
      options.enumerateSessions ?? (() => defaultEnumerate(this.socketPath));
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 2000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this._ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  static start(
    options: TmuxControlConnectionOptions = {},
  ): TmuxControlConnection {
    if (TmuxControlConnection.instance !== null) {
      return TmuxControlConnection.instance;
    }
    const conn = new TmuxControlConnection(options);
    TmuxControlConnection.instance = conn;
    void conn.connect();
    return conn;
  }

  // Test seam: drop the singleton so the next start() returns a fresh
  // instance. Never called from app code.
  static __resetForTesting(): void {
    const existing = TmuxControlConnection.instance;
    TmuxControlConnection.instance = null;
    existing?.close();
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  getState(): ConnectionStateEvent {
    return {
      status: this.status,
      reason: this.statusReason,
      reconnectAttempts: this.reconnectAttempts,
      observedSessions: this.clients.size,
    };
  }

  onConnectionState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  // [LAW:dataflow-not-control-flow] on() classifies by event NAME (a value
  // on the event) and routes accordingly. Session-scoped events fan to
  // every client in the mesh (each client emits %output only for its own
  // attached session, so without fan-out we'd miss N-1 sessions' worth of
  // output). Server-scoped events attach to the topology source alone to
  // avoid N-way duplicate delivery of events tmux emits to every client.
  //
  // Re-elections and (re)spawns re-apply listeners automatically — callers
  // never re-subscribe themselves after a transport drop.
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void;
  on(event: "*", handler: (ev: EmitterMessage) => void): () => void;
  on(
    event: keyof TmuxEventMap | "*",
    handler: (ev: unknown) => void,
  ): () => void {
    if (event === "*") {
      // Synthesize a wildcard by attaching the same handler to every event
      // type we know about. Synthetic events (connection-state, exit) are
      // excluded from the fan-out — those are connection-level lifecycle and
      // are dispatched directly to wildcard listeners from broadcastState().
      const children: (() => void)[] = [];
      for (const ev of WILDCARD_FANOUT_EVENTS) {
        children.push(this.on(ev, handler));
      }
      const entry: RegisteredListener = {
        event,
        handler,
        scope: "synthetic",
        children,
      };
      this.listeners.push(entry);
      return () => this.removeListener(entry);
    }
    if (SYNTHETIC_EVENTS.has(event)) {
      // Synthetic events flow through the connection's own lifecycle, not
      // through any underlying client. Register but do not attach to any
      // TmuxClient — the connection synthesizes them in setStatus/close.
      const entry: RegisteredListener = {
        event,
        handler,
        scope: "synthetic",
      };
      this.listeners.push(entry);
      return () => this.removeListener(entry);
    }
    const scope: "session-scoped" | "server-scoped" = SESSION_SCOPED_EVENTS.has(
      event,
    )
      ? "session-scoped"
      : "server-scoped";
    const entry: RegisteredListener = {
      event,
      handler,
      scope,
    };
    this.listeners.push(entry);
    this.attachListener(entry);
    return () => this.removeListener(entry);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: EmitterMessage) => void): void;
  off(event: keyof TmuxEventMap | "*", handler: (ev: unknown) => void): void {
    // Find the matching entry by (event, handler) identity. Linear scan is
    // fine — listener counts are small (low single digits per consumer).
    for (let i = this.listeners.length - 1; i >= 0; i -= 1) {
      const entry = this.listeners[i];
      if (entry === undefined) continue;
      if (entry.event === event && entry.handler === handler) {
        this.removeListener(entry);
        return;
      }
    }
  }

  // Library-level connectionState getter — the bridge consults it on
  // late-joining renderers to send a synthetic snapshot. Projects the
  // connection's own status onto the library's ConnectionState shape.
  get connectionState(): ConnectionState {
    return projectConnectionState(this.status, this.statusReason);
  }

  // [LAW:dataflow-not-control-flow] Every write operation runs the same
  // pipeline: pick any ready client → forward → return tmux's response.
  // The picker uses topology source as a stable preference and falls back
  // to first-in-map, but no caller cares which client serviced the request.
  execute(command: string): Promise<CommandResponse> {
    return this.dispatch((c) => c.execute(command));
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.dispatch((c) => c.sendKeys(target, keys));
  }

  listPanes(): Promise<CommandResponse> {
    return this.dispatch((c) => c.listPanes());
  }

  listWindows(): Promise<CommandResponse> {
    return this.dispatch((c) => c.listWindows());
  }

  splitWindow(options?: SplitOptions): Promise<CommandResponse> {
    return this.dispatch((c) => c.splitWindow(options));
  }

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.dispatch((c) => c.setSize(width, height));
  }

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    // [LAW:locality-or-seam] Route to the client whose session contains
    // the pane. tmux's refresh-client -A is per-client; pause/resume only
    // takes effect on the client whose attached session sees the pane.
    // Fall back to any client when we haven't observed output for this
    // pane yet (first interaction): the call still reaches tmux, and the
    // pause/resume will rebind on the next output cycle.
    const sessionId = this.paneSessions.get(paneId);
    if (sessionId !== undefined) {
      const client = this.clients.get(sessionId);
      if (client !== undefined) return client.setPaneAction(paneId, action);
    }
    return this.dispatch((c) => c.setPaneAction(paneId, action));
  }

  setFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.dispatch((c) => c.setFlags(flags));
  }

  clearFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.dispatch((c) => c.clearFlags(flags));
  }

  requestReport(paneId: number, report: string): Promise<CommandResponse> {
    return this.dispatch((c) => c.requestReport(paneId, report));
  }

  queryClipboard(): Promise<CommandResponse> {
    return this.dispatch((c) => c.queryClipboard());
  }

  // [LAW:dataflow-not-control-flow] Subscriptions are sticky and fanned:
  // every client in the mesh receives the registration, so a subscription
  // whose target binds to a specific session (e.g. a pane id "%X" only
  // resolves on the client attached to X's session) fires its
  // subscription-changed events on whichever client owns the match. Cross-
  // session targets ("(s)", "%*", "@*") generate duplicates across clients
  // that subscribers handle idempotently — the alternative (routing per-
  // target to specific clients) would require parsing tmux target syntax
  // here and bake a structural distinction into the mesh that doesn't exist
  // anywhere else. Same code path every subscription, variability is in the
  // data tmux emits in response.
  async subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    this.subscriptions.set(name, { name, what, format });
    if (this.clients.size === 0) {
      // No clients yet — subscription is recorded and will be applied when
      // the first client spawns. [LAW:no-defensive-null-guards] honest empty
      // state, no fallback to a privileged client.
      return syntheticOk();
    }
    // Fire on every client; aggregate the response. Successful subscribes
    // on ANY client mean the subscription is live (events will fire from
    // that client's session scope). If every client failed — whether by
    // throwing OR by replying with {success: false} — the subscription is
    // effectively dead, and we report that honestly so callers (notably
    // the topology tracker's subscriptionsRegistered one-shot) keep
    // retrying. syntheticOk() is only for the empty-mesh "recorded but
    // not yet applied" case; it never papers over a real failure.
    return aggregateMeshResponses(
      await Promise.all(
        [...this.clients.values()].map((client) =>
          client.subscribeRaw(name, what, format).catch(meshErrorResponse),
        ),
      ),
    );
  }

  async unsubscribe(name: string): Promise<CommandResponse> {
    this.subscriptions.delete(name);
    if (this.clients.size === 0) return syntheticOk();
    // Same aggregation as subscribeRaw: report honestly when every client
    // failed to process the unsubscribe so callers can retry instead of
    // silently leaving stale subscriptions active.
    return aggregateMeshResponses(
      await Promise.all(
        [...this.clients.values()].map((client) =>
          client.unsubscribe(name).catch(meshErrorResponse),
        ),
      ),
    );
  }

  // Library compatibility: detach() asks tmux to disconnect each client
  // cleanly. close() tears down the mesh and kills owned sessions.
  detach(): void {
    for (const client of this.clients.values()) client.detach();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close every client. detach handlers don't fire here because the
    // mesh is being torn down deliberately.
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.topologySourceId = null;
    // [LAW:single-enforcer] The ONE place that reads ownedSessionIds.
    // Each owned session was created by promptctl — tear it down so the
    // user's tmux server doesn't accumulate detached promptctl sessions
    // across restarts. Non-owned sessions are left alone.
    const owned = [...this.ownedSessionIds];
    this.ownedSessionIds.clear();
    void Promise.all(
      owned.map((id) =>
        defaultKillSession(id, this.socketPath).catch((err) => {
          console.error(`[tmux-control] kill-session ${id} failed:`, err);
        }),
      ),
    );
    this.setStatus("closed", "explicit close");
  }

  // -------------------------------------------------------------------------
  // Internal — lifecycle
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.setStatus("connecting");
    await this.reconcile();
    if (this.closed) return;
    // [LAW:single-enforcer] reconcile() is the sole site that transitions
    // status to ready / no-sessions / closed-on-failure. connect() doesn't
    // re-derive the post-reconcile status from clients.size — that would
    // overwrite a "closed" status reconcile set when enumeration failed
    // with a misleading "no-sessions."
    this.readyResolve();
    this.scheduleReconcile();
  }

  // [LAW:dataflow-not-control-flow] One reconcile pipeline. Runs on
  // initial connect, on every periodic tick, and after a client's exit
  // (so a session that disappeared and returned gets re-spawned the same
  // way as any newly-observed session).
  private async reconcile(): Promise<void> {
    if (this.reconcileInFlight) {
      // A reconcile is already running; remember to run again afterward so
      // an event that arrived mid-cycle isn't lost.
      this.reconcileScheduled = true;
      return;
    }
    this.reconcileInFlight = true;
    try {
      let ids: SessionId[];
      try {
        ids = await this.enumerateSessions();
      } catch (err) {
        // [LAW:no-defensive-null-guards] An enumerate failure is honest
        // information, not "no sessions." It's the difference between
        // "tmux says zero sessions exist" (legitimate empty mesh) and
        // "tmux failed to answer" (binary missing, permission error,
        // socket unreachable). The default enumerator already converts
        // the benign "no server running" case into an empty result; any
        // exception that surfaces here is fatal. Report it via status so
        // the debug UI doesn't misrepresent it as no-sessions; the
        // periodic timer keeps probing until the condition clears.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[tmux-control] enumerate-sessions failed: ${reason}`);
        if (!this.closed && this.status !== "closed") {
          this.setStatus("closed", `enumerate failed: ${reason}`);
        }
        return;
      }
      if (this.closed) return;
      const target = new Set(ids);
      // Spawn for ids that appeared.
      for (const id of target) {
        if (!this.clients.has(id)) this.spawnClient(id);
      }
      // Drop ids that disappeared. We do NOT eagerly drop here based on the
      // periodic enumeration alone — a client whose underlying session was
      // killed will emit `exit` and that path removes it. But if a session
      // vanished without the transport dying (very rare, e.g. external
      // detach), the enumeration is the second line of defense.
      for (const [id, client] of [...this.clients]) {
        if (!target.has(id)) {
          this.clients.delete(id);
          // Detach session-scoped listeners before closing.
          for (const entry of this.listeners) {
            if (entry.scope === "session-scoped") clientOff(client, entry);
          }
          if (this.topologySourceId === id) {
            this.detachServerScopedFrom(client);
            this.topologySourceId = null;
          }
          client.close();
        }
      }
      this.electTopologySource();
      this.refreshStatus();
    } finally {
      this.reconcileInFlight = false;
      if (this.reconcileScheduled) {
        this.reconcileScheduled = false;
        // Defer one tick so we don't tight-loop if the scheduled flag
        // keeps getting set during the run.
        setTimeout(() => void this.reconcile(), 0);
      }
    }
  }

  private spawnClient(sessionId: SessionId): void {
    let transport: TmuxTransport;
    try {
      transport = this.transportFactory(sessionId);
    } catch (err) {
      console.error(
        `[tmux-control] spawn transport for ${sessionId} failed:`,
        err,
      );
      return;
    }
    const client = new TmuxClient(transport);
    this.clients.set(sessionId, client);

    // Internal exit handler — removes the entry from the mesh and schedules
    // a reconcile (the session may have been killed, or just the client's
    // transport died and the session still exists). Stale events are
    // ignored via the identity check.
    client.on("exit", () => {
      if (this.clients.get(sessionId) !== client) return;
      this.removeClient(sessionId, "transport closed");
      this.scheduleReconcileNow();
    });

    // [LAW:single-enforcer] Pane-source learner. Every %output / %extended-
    // output event tells us "pane P belongs to this client's session" —
    // record it so setPaneAction can route correctly. The recording is
    // idempotent (re-assigning to the same session is a no-op).
    const learnPane = (msg: { paneId: number }): void => {
      this.paneSessions.set(msg.paneId, sessionId);
    };
    client.on("output", learnPane);
    client.on("extended-output", learnPane);

    // Attach existing session-scoped listeners to the new client. Server-
    // scoped listeners attach via electTopologySource() if this client
    // becomes the source.
    for (const entry of this.listeners) {
      if (entry.scope === "session-scoped") clientOn(client, entry);
    }

    // Configure pause-after with the library's default (30s idle). The
    // output router auto-resumes via setPaneAction(Continue) routed to
    // the client whose session contains the pane.
    void client.setFlags(["pause-after=30"]).catch((err) => {
      console.error(`[tmux-control] setFlags for ${sessionId} failed:`, err);
    });

    // [LAW:single-enforcer] Re-apply every sticky subscription to the new
    // client. tmux subscriptions are per-client; without this, a client
    // spawned after subscribeRaw() was first called would never receive the
    // subscription-changed events for entities in its session.
    for (const sub of this.subscriptions.values()) {
      void client.subscribeRaw(sub.name, sub.what, sub.format).catch((err) => {
        console.error(
          `[tmux-control] subscribe ${sub.name} on ${sessionId} failed:`,
          err,
        );
      });
    }
  }

  private removeClient(sessionId: SessionId, reason: string): void {
    const client = this.clients.get(sessionId);
    if (client === undefined) return;
    this.clients.delete(sessionId);

    // [LAW:one-source-of-truth] Drop pane bindings learned from this client.
    // If those panes still exist (under a different session), the next
    // %output event will rebind them.
    for (const [paneId, sid] of this.paneSessions) {
      if (sid === sessionId) this.paneSessions.delete(paneId);
    }

    // Detach session-scoped listeners.
    for (const entry of this.listeners) {
      if (entry.scope === "session-scoped") clientOff(client, entry);
    }

    // If this was the topology source, transfer the role.
    if (this.topologySourceId === sessionId) {
      this.detachServerScopedFrom(client);
      this.topologySourceId = null;
      this.electTopologySource();
    }

    client.close();
    this.refreshStatus(reason);
  }

  // [LAW:dataflow-not-control-flow] Election is pure data:
  //  - If we already have a valid source in the mesh, keep it.
  //  - Otherwise pick the first id in the map.
  //  - On a fresh election, attach server-scoped listeners to the chosen
  //    client and re-apply every sticky subscription.
  // No caller branches on which session was elected — the role is invisible
  // outside this method and its dual (detach when the role transfers).
  private electTopologySource(): void {
    if (
      this.topologySourceId !== null &&
      this.clients.has(this.topologySourceId)
    ) {
      return;
    }
    const first = this.clients.keys().next();
    if (first.done) {
      this.topologySourceId = null;
      return;
    }
    const sessionId = first.value;
    this.topologySourceId = sessionId;
    const source = this.clients.get(sessionId);
    if (source === undefined) return; // unreachable: we just read from the map
    this.attachServerScopedTo(source);
    // [LAW:dataflow-not-control-flow] Sticky subscriptions are re-applied
    // by spawnClient (every client gets every subscription), not here. The
    // role of topology-source is just "which client carries server-scoped
    // event listeners" — subscriptions are mesh-wide.
  }

  private attachServerScopedTo(client: TmuxClient): void {
    for (const entry of this.listeners) {
      if (entry.scope === "server-scoped") clientOn(client, entry);
    }
  }

  private detachServerScopedFrom(client: TmuxClient): void {
    for (const entry of this.listeners) {
      if (entry.scope === "server-scoped") clientOff(client, entry);
    }
  }

  private attachListener(entry: RegisteredListener): void {
    if (entry.scope === "session-scoped") {
      for (const client of this.clients.values()) clientOn(client, entry);
      return;
    }
    if (entry.scope === "server-scoped") {
      const source = this.topologySource();
      if (source !== null) clientOn(source, entry);
    }
    // Synthetic listeners are not attached to any client — they're invoked
    // from setStatus / close paths inside this class.
  }

  private removeListener(entry: RegisteredListener): void {
    const idx = this.listeners.indexOf(entry);
    if (idx >= 0) this.listeners.splice(idx, 1);
    if (entry.children !== undefined) {
      for (const off of entry.children) off();
      return;
    }
    if (entry.scope === "session-scoped") {
      for (const client of this.clients.values()) clientOff(client, entry);
      return;
    }
    if (entry.scope === "server-scoped") {
      const source = this.topologySource();
      if (source !== null) clientOff(source, entry);
    }
  }

  private topologySource(): TmuxClient | null {
    if (this.topologySourceId === null) return null;
    return this.clients.get(this.topologySourceId) ?? null;
  }

  private anyClient(): TmuxClient | null {
    // Prefer the topology source for write routing — it's already the
    // designated server-scoped channel, so we keep the bridge's command
    // dispatch on a single client when possible (matches what tmux
    // tooling expects when an "active client" exists).
    const source = this.topologySource();
    if (source !== null) return source;
    const first = this.clients.values().next();
    return first.done ? null : first.value;
  }

  private dispatch<R>(op: (client: TmuxClient) => Promise<R>): Promise<R> {
    const client = this.anyClient();
    if (client === null) {
      // [LAW:no-defensive-null-guards] An empty mesh is a legitimate state;
      // writes against it fail loudly so callers see the no-sessions
      // condition explicitly rather than getting a silent "success" or a
      // fallback to a privileged session.
      return Promise.reject(
        new Error("tmux control mesh is empty — no sessions observed"),
      );
    }
    return op(client);
  }

  // refreshStatus projects the mesh's data into the public status. Called
  // wherever the mesh size changes — keeps status and mesh from drifting.
  private refreshStatus(reason?: string): void {
    if (this.closed) return;
    if (this.clients.size === 0) {
      if (this.status !== "no-sessions") this.setStatus("no-sessions", reason);
      else this.broadcastState();
      return;
    }
    if (this.status !== "ready") this.setStatus("ready", reason);
    else this.broadcastState();
  }

  private scheduleReconcile(): void {
    if (this.closed) return;
    if (this.reconcileTimer !== null) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile().finally(() => this.scheduleReconcile());
    }, this.reconcileIntervalMs);
  }

  private scheduleReconcileNow(): void {
    if (this.closed) return;
    // Cancel the long-tail tick — we want a fresh run NOW (e.g. after a
    // client exit). The trailing tick will be re-armed after the run.
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    setTimeout(() => {
      void this.reconcile().finally(() => this.scheduleReconcile());
    }, 0);
  }

  private setStatus(status: ConnectionStatus, reason?: string): void {
    this.status = status;
    this.statusReason = reason;
    this.broadcastState();
  }

  private broadcastState(): void {
    const event = this.getState();
    for (const listener of this.stateListeners) listener(event);
    // Synthetic "connection-state" dispatch for library-compatible
    // consumers (notably the bridge). The handler receives a
    // ConnectionStateMessage shaped like the library's lifecycle envelope.
    // Both direct ("connection-state") and wildcard ("*") subscribers see
    // it — the library does the same.
    const msg: ConnectionStateMessage = {
      type: "connection-state",
      state: this.connectionState,
    };
    for (const entry of this.listeners) {
      if (entry.scope !== "synthetic") continue;
      if (entry.event === "connection-state" || entry.event === "*") {
        entry.handler(msg);
      }
    }
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

// Enumerate session ids via a tmuxExec shellout. The list-sessions response
// is one line per session in `$id` format; trailing newline trimmed.
async function defaultEnumerate(
  socketPath: string | null,
): Promise<SessionId[]> {
  const socketArgs = socketPath === null ? [] : ["-L", socketPath];
  try {
    const stdout = await tmuxExec([
      ...socketArgs,
      "list-sessions",
      "-F",
      "#{session_id}",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line as SessionId);
  } catch (err) {
    if (
      err instanceof TmuxError &&
      /no server running|error connecting to/.test(err.stderr)
    ) {
      // No tmux server yet → no sessions. Honest empty result; the periodic
      // reconcile will pick up the server once a session is created.
      return [];
    }
    throw err;
  }
}

async function defaultKillSession(
  sessionId: SessionId,
  socketPath: string | null,
): Promise<void> {
  const socketArgs = socketPath === null ? [] : ["-L", socketPath];
  await tmuxExec([...socketArgs, "kill-session", "-t", sessionId]);
}

// [LAW:locality-or-seam] The single cast site for client.on/off. TmuxClient's
// overloaded signature requires a specific event-name literal tied to a
// specific handler shape; we hold an erased entry (string + unknown-arg
// handler) and want to dispatch without re-deriving the union. The cast is
// safe because we round-trip the same (event, handler) pair through both
// sides — what we put in via on(), we take out via off().
interface LooseEmitter {
  on(event: string, handler: (ev: unknown) => void): void;
  off(event: string, handler: (ev: unknown) => void): void;
}

function clientOn(client: TmuxClient, entry: RegisteredListener): void {
  (client as unknown as LooseEmitter).on(entry.event as string, entry.handler);
}

function clientOff(client: TmuxClient, entry: RegisteredListener): void {
  try {
    (client as unknown as LooseEmitter).off(
      entry.event as string,
      entry.handler,
    );
  } catch {
    // Calling off() on an already-torn-down client is a no-op — the
    // listener is gone with the client. The throw catches that race.
  }
}

// Synthetic CommandResponse for paths where the operation is recorded but
// not yet executed against tmux (subscribeRaw/unsubscribe before any clients
// exist). Carries non-conflicting placeholder values so it satisfies
// CommandResponse without colliding with real tmux replies.
function syntheticOk(): CommandResponse {
  return {
    success: true,
    output: [],
    commandNumber: 0,
    timestamp: Date.now(),
  };
}

// Converts a thrown client-side error (transport drop mid-call, library
// exception) into a CommandResponse-shaped failure. Used by the mesh-wide
// subscribeRaw/unsubscribe aggregation so a throw and a {success: false}
// reply collapse to the same shape for the aggregator to reason over.
function meshErrorResponse(err: unknown): CommandResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    output: [message],
    commandNumber: 0,
    timestamp: Date.now(),
  };
}

// [LAW:no-defensive-null-guards] Aggregate per-client responses honestly:
//   - any success → return the first success (subscription is live on that
//     client; mesh-wide intent achieved)
//   - all failed  → return the first failure (caller sees success:false and
//     can retry)
//   - empty input → unreachable here (callers gate on clients.size first)
//
// This is the load-bearing distinction the prior implementation missed:
// returning syntheticOk() when every client failed papered over the failure
// and broke the topology tracker's retry loop.
function aggregateMeshResponses(
  results: readonly CommandResponse[],
): CommandResponse {
  const success = results.find((r) => r.success);
  if (success !== undefined) return success;
  const failure = results[0];
  if (failure !== undefined) return failure;
  // Defensive — every caller currently gates on this.clients.size > 0
  // before reaching the aggregator, so an empty results array means the
  // mesh raced empty mid-call. Honest failure response.
  return {
    success: false,
    output: ["mesh empty during dispatch"],
    commandNumber: 0,
    timestamp: Date.now(),
  };
}

// Project the connection's status onto the library's ConnectionState shape.
// `no-sessions` and `connecting` both map to the library's `connecting`
// (the mesh is alive but no traffic is observable to consumers) — this is
// the closest semantic the library exposes; the richer promptctl status is
// available via onConnectionState().
//
// The library's `closed` reason is a 3-value union (exit | transport-error
// | disposed). Map our richer `statusReason` string onto the union so the
// bridge consumer can distinguish explicit-close (disposed) from a fatal
// underlying failure (transport-error). The full reason string remains
// available to promptctl-aware consumers via onConnectionState().
function projectConnectionState(
  status: ConnectionStatus,
  reason: string | undefined,
): ConnectionState {
  if (status === "ready") return { status: "ready" };
  if (status === "closed") {
    return { status: "closed", reason: mapCloseReason(reason) };
  }
  // connecting | no-sessions — surface as "connecting" with no traffic yet.
  return { status: "connecting" };
}

// [LAW:dataflow-not-control-flow] The mapping is data: our internal close
// reasons are a small set of well-known strings emitted from the two
// closing paths (explicit close() and fatal enumerate failure). Each maps
// to the library's nearest semantic. Unknown reasons default to
// transport-error, the broadest "something went wrong externally" bucket.
function mapCloseReason(
  reason: string | undefined,
): "exit" | "transport-error" | "disposed" {
  if (reason === undefined) return "disposed";
  if (reason === "explicit close") return "disposed";
  return "transport-error";
}
