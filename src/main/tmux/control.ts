// [LAW:one-source-of-truth] Sole producer of tmux-server state and the only
// channel through which the rest of the app drives tmux. Outside callers see a
// stable handle (`client`, `ready`, `on`) regardless of whether the underlying
// TmuxClient has been replaced after a reconnect.
//
// [LAW:single-enforcer] Connect / reconnect / close transitions go through this
// class. tmux delivers %output only for the session each control client is
// attached to, so coverage across sessions is the cross-cutting invariant: a
// mesh of one client per *observed* session is what keeps %output and output-
// pattern matching from silently going dark when the UI navigates between
// sessions. observeSessions() is its only writer.
//
// [LAW:dataflow-not-control-flow] connect() runs the same primary lifecycle
// every invocation: setStatus("connecting") → spawn → register listeners →
// setFlags → setStatus("ready"). Failures flow into setStatus("closed",
// reason) and a scheduled reconnect — no branch that "skips" the lifecycle.
// spawnFollower() runs an analogous but distinct sequence — spawn transport
// → register session-scoped listeners → setFlags — and does NOT touch
// connection status; follower failures only log and rely on the next
// topology snapshot for reconciliation. The connection is "ready" iff the
// primary is ready, independent of how many followers exist.
//
// [LAW:one-type-per-behavior] Each registered listener carries an event-type
// classification — server-scoped (attaches to primary only) or session-scoped
// (attaches to every client). The set of session-scoped events is fixed below
// and is the only place callers' fan-out behavior can change.

import {
  TmuxClient,
  spawnTmux,
  type TmuxEventMap,
  type TmuxTransport,
} from "tmux-control-mode-js";
import { PaneAction } from "tmux-control-mode-js/protocol";
import type { SessionId } from "../../shared/types";
import { ensureSession } from "./session";

export type ConnectionStatus = "connecting" | "ready" | "closed";

export interface ConnectionStateEvent {
  readonly status: ConnectionStatus;
  readonly reason?: string;
  // [LAW:dataflow-not-control-flow] Counter is data on every event so the
  // debug panel renders the same way for every transition — no branch on
  // "is this a reconnect."
  readonly reconnectAttempts: number;
}

export interface TmuxControlConnectionOptions {
  // Promptctl-owned session name. The connection bootstraps this session
  // (creates if missing, attaches if it exists) before the primary client
  // attaches. Required — every connection is scoped to a named session.
  readonly sessionName: string;
  // Transport factory — overridable for tests. Receives a tmux target (a
  // session name for the primary, a `$N` session id for followers). The
  // default spawns the control client with `attach-session -t <target>`
  // baked in so tmux never has the chance to create an anonymous session.
  readonly transportFactory?: (target: string) => TmuxTransport;
  // Bootstrap step: ensure the session exists. Default probes with
  // `tmux has-session -t =<name>` and creates with `tmux new-session -d
  // -s <name>` only if missing. Overridable for tests so unit suites
  // don't need a real tmux binary on PATH.
  readonly bootstrap?: () => Promise<void>;
  // Backoff between reconnect attempts (primary client only — followers
  // are respawned by the next observeSessions() reconciliation).
  readonly reconnectDelayMs?: number;
}

type StateListener = (event: ConnectionStateEvent) => void;

// [LAW:one-source-of-truth] §2.1 of docs/tmux-integration-plan.md — the
// canonical set of events tmux scopes to a single attached client. These fan
// to every client (primary + followers) so multi-session coverage doesn't
// silently drop. Anything not in this set is server-wide and attaches to
// primary only to avoid duplicate delivery.
const SESSION_SCOPED_EVENTS: ReadonlySet<keyof TmuxEventMap> = new Set([
  "output",
  "extended-output",
  "pause",
  "continue",
]);

type EventKey = keyof TmuxEventMap;

// [LAW:dataflow-not-control-flow] A registered listener is data — event name,
// handler, and the fan-out scope derived from the event name. The (re)attach
// loop reads `scope` to decide whether a particular client gets this handler;
// there is no branch in the loop itself.
interface RegisteredListener {
  readonly event: EventKey;
  readonly handler: (ev: TmuxEventMap[EventKey]) => void;
  readonly scope: "primary" | "all";
}

// A follower owns its transport and its client. Teardown derives the set of
// listeners to detach from `this.listeners` at the moment of teardown — so
// listener subscribe/unsubscribe never has to push or remove disposer
// closures per follower, and the stored shape stays small.
interface FollowerClient {
  readonly sessionId: SessionId;
  readonly client: TmuxClient;
  readonly transport: TmuxTransport;
  // Set once we've issued the teardown (or the transport dropped on its own)
  // so the unexpected-exit handler and tearDownFollower don't both delete
  // the row and double-call client.close().
  shuttingDown: boolean;
}

export class TmuxControlConnection {
  private static instance: TmuxControlConnection | null = null;

  private readonly sessionName: string;
  private readonly transportFactory: (target: string) => TmuxTransport;
  private readonly bootstrap: () => Promise<void>;
  private readonly reconnectDelayMs: number;
  private readonly stateListeners = new Set<StateListener>();
  private readonly listeners: RegisteredListener[] = [];

  private primaryClient: TmuxClient | null = null;
  private readonly followers = new Map<SessionId, FollowerClient>();
  // [LAW:one-source-of-truth] The last observation-set passed to
  // observeSessions(). Read by the follower exit handler to decide whether
  // to schedule a respawn — without it, an isolated follower transport drop
  // that doesn't perturb the pane list would silently go dark since the
  // topology tracker only broadcasts on diff. Re-observation calls overwrite
  // this set; close() clears it.
  private observed: ReadonlySet<SessionId> = new Set();
  // Per-session pending respawn timers. One in flight at a time per
  // session; cleared when a session leaves observation or close() runs.
  private readonly respawnTimers = new Map<
    SessionId,
    ReturnType<typeof setTimeout>
  >();
  // [LAW:dataflow-not-control-flow] Backoff between unexpected-exit and
  // respawn attempt. Long enough for an imminent window-close +
  // topology-refresh to win the race when the session genuinely died,
  // short enough that a healthy session's brief blip recovers quickly.
  private readonly followerRespawnDelayMs = 500;

  private status: ConnectionStatus = "connecting";
  private statusReason: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readyResolve: () => void = () => undefined;
  private readonly _ready: Promise<void>;

  private reconnectAttempts = 0;

  private constructor(options: TmuxControlConnectionOptions) {
    // [LAW:dataflow-not-control-flow] PROMPTCTL_TMUX_SOCKET is read once into a
    // value; the same factory and bootstrap paths run regardless of whether
    // it is set — only the data (socketPath / -L args) varies.
    const envSocket = process.env.PROMPTCTL_TMUX_SOCKET ?? null;
    const sessionName = options.sessionName;
    this.sessionName = sessionName;
    this.transportFactory =
      options.transportFactory ??
      ((target) => {
        // [LAW:single-enforcer] All transport spawns route through here so
        // the `attach-session -t <target>` argv is never bypassed — that's
        // what prevents tmux from inventing an anonymous session.
        const args = ["attach-session", "-t", target];
        return envSocket === null
          ? spawnTmux(args)
          : spawnTmux(args, { socketPath: envSocket });
      });
    this.bootstrap =
      options.bootstrap ?? (() => ensureSession(sessionName, envSocket));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this._ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  static start(
    options: TmuxControlConnectionOptions,
  ): TmuxControlConnection {
    if (TmuxControlConnection.instance !== null) {
      return TmuxControlConnection.instance;
    }
    const conn = new TmuxControlConnection(options);
    TmuxControlConnection.instance = conn;
    void conn.connect();
    return conn;
  }

  // [LAW:no-defensive-null-guards] Test-only escape hatch: clears the singleton
  // so the next start() returns a fresh instance. Never call from app code.
  static __resetForTesting(): void {
    const existing = TmuxControlConnection.instance;
    TmuxControlConnection.instance = null;
    existing?.close();
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  // The primary client — attached to the owned session, owns every write and
  // every server-wide subscription. Followers are an implementation detail of
  // the mesh and are not exposed.
  get client(): TmuxClient | null {
    return this.primaryClient;
  }

  // [LAW:single-enforcer] The only writer of the follower set. main.ts wires
  // this to the topology snapshot — any session promptctl sees in the pane
  // list becomes an observation, and a follower spawns to deliver its
  // %output. Idempotent — calls with the same set are no-ops.
  //
  // [LAW:dataflow-not-control-flow] Reconcile reads the observed set as data
  // and runs the same add/remove loops every invocation; the variability is
  // which session ids are new vs gone, not which branch fires.
  observeSessions(sessions: ReadonlySet<SessionId>): void {
    this.observed = new Set(sessions);
    if (this.closed) return;
    // Add followers for newly-observed sessions. Skip if we already have one
    // — observation is a set, not a queue.
    for (const sessionId of sessions) {
      if (this.followers.has(sessionId)) continue;
      this.spawnFollower(sessionId);
    }
    // Tear down followers that are no longer observed. Also cancel any
    // pending respawn timer for a session that just left the set —
    // otherwise it would fire after the session is gone and try to attach
    // to a non-existent target.
    for (const [sessionId, follower] of [...this.followers]) {
      if (sessions.has(sessionId)) continue;
      this.tearDownFollower(sessionId, follower);
    }
    for (const sessionId of [...this.respawnTimers.keys()]) {
      if (sessions.has(sessionId)) continue;
      this.cancelRespawn(sessionId);
    }
  }

  getState(): ConnectionStateEvent {
    return {
      status: this.status,
      reason: this.statusReason,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  onConnectionState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  // [LAW:one-type-per-behavior] Subscribe to a TmuxClient event in a
  // reconnect-safe, mesh-aware way. The event's classification (session-scoped
  // vs server-scoped, see SESSION_SCOPED_EVENTS) decides whether the handler
  // is attached to every client or just the primary. Callers do not branch
  // on this themselves — the connection owns the rule so the consumer surface
  // stays uniform across the mesh.
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void {
    const scope: "primary" | "all" = SESSION_SCOPED_EVENTS.has(event)
      ? "all"
      : "primary";
    const entry: RegisteredListener = {
      event,
      handler: handler as RegisteredListener["handler"],
      scope,
    };
    this.listeners.push(entry);
    if (this.primaryClient !== null) {
      this.primaryClient.on(event, handler);
    }
    if (scope === "all") {
      for (const follower of this.followers.values()) {
        follower.client.on(event, handler);
      }
    }
    return () => {
      const idx = this.listeners.indexOf(entry);
      if (idx >= 0) this.listeners.splice(idx, 1);
      if (this.primaryClient !== null) {
        this.primaryClient.off(event, handler);
      }
      if (scope === "all") {
        for (const follower of this.followers.values()) {
          follower.client.off(event, handler);
        }
      }
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const sessionId of [...this.respawnTimers.keys()]) {
      this.cancelRespawn(sessionId);
    }
    for (const [sessionId, follower] of [...this.followers]) {
      this.tearDownFollower(sessionId, follower);
    }
    this.observed = new Set();
    const client = this.primaryClient;
    this.primaryClient = null;
    client?.close();
    this.setStatus("closed", "explicit close");
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.setStatus("connecting");

    const bootstrapped = await this.runBootstrap();
    if (this.closed) return;
    if (!bootstrapped) {
      // bootstrap already set the failure reason on the status.
      this.scheduleReconnect();
      return;
    }

    const client = this.spawnPrimaryClient();
    if (client === null) {
      // spawn already routed the failure to setStatus + reconnect.
      return;
    }

    if (this.closed) {
      client.close();
      return;
    }

    try {
      await client.setFlags(["pause-after=2"]);
    } catch (err) {
      this.handlePrimaryFailure(client, errorMessage(err));
      return;
    }

    if (this.closed) {
      client.close();
      return;
    }

    this.setStatus("ready");
    this.readyResolve();
  }

  private async runBootstrap(): Promise<boolean> {
    try {
      await this.bootstrap();
      return true;
    } catch (err) {
      // Bootstrap blew up — most commonly because the tmux binary is
      // missing on PATH. Treat as not-ready and back off; the next attempt
      // will retry. The reason carries the underlying tmux/exec message
      // so the debug surface shows a real diagnostic.
      this.setStatus("closed", errorMessage(err));
      return false;
    }
  }

  private spawnPrimaryClient(): TmuxClient | null {
    let transport: TmuxTransport;
    try {
      transport = this.transportFactory(this.sessionName);
    } catch (err) {
      this.setStatus("closed", errorMessage(err));
      this.scheduleReconnect();
      return null;
    }

    const client = new TmuxClient(transport);
    this.primaryClient = client;
    for (const lst of this.listeners) {
      // Primary receives every registered listener — server-scoped events
      // come only from here, and session-scoped events flow from here for
      // the owned session's panes (followers cover the foreign sessions).
      // main.ts explicitly excludes the owned session from observeSessions()
      // so no follower duplicates this client's %output delivery.
      client.on(lst.event, lst.handler);
    }
    this.installPauseAutoResume(client, "primary");
    client.on("exit", (ev) =>
      this.handlePrimaryFailure(client, ev.reason ?? "transport closed"),
    );
    return client;
  }

  private handlePrimaryFailure(client: TmuxClient, reason: string): void {
    if (this.primaryClient !== client) return; // stale event from a prior client
    this.primaryClient = null;
    client.close();
    if (this.closed) return;
    this.setStatus("closed", reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closed) return;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelayMs);
  }

  private setStatus(status: ConnectionStatus, reason?: string): void {
    this.status = status;
    this.statusReason = reason;
    const event = this.getState();
    for (const listener of this.stateListeners) {
      listener(event);
    }
  }

  // [LAW:dataflow-not-control-flow] Same spawn sequence for every follower —
  // create transport → wire listeners → set flags → set up self-cleanup on
  // transport exit. The session id is data; the path is fixed.
  private spawnFollower(sessionId: SessionId): void {
    let transport: TmuxTransport;
    try {
      transport = this.transportFactory(sessionId);
    } catch (err) {
      console.error(
        `[tmux-control] follower(${sessionId}) transport spawn failed: ${errorMessage(err)}`,
      );
      return;
    }

    const client = new TmuxClient(transport);
    const follower: FollowerClient = {
      sessionId,
      client,
      transport,
      shuttingDown: false,
    };
    this.followers.set(sessionId, follower);

    // Attach every session-scoped listener that's currently registered.
    // Teardown will derive its detach pass from `this.listeners` at the time
    // it runs, so we don't store per-follower disposers.
    for (const lst of this.listeners) {
      if (lst.scope !== "all") continue;
      client.on(lst.event, lst.handler);
    }

    this.installPauseAutoResume(client, `follower(${sessionId})`);

    // Unexpected transport drop: drop the follower from the map and
    // schedule a backoff respawn IF the session is still observed. The
    // backoff window gives an imminent window-close + topology reconcile a
    // chance to win the race when the session genuinely died — if topology
    // wins, the session leaves `this.observed` and the timer is cancelled
    // by observeSessions(). A respawn relying solely on the next topology
    // snapshot would fail silently when a follower transport drops without
    // perturbing the pane list (topology only broadcasts on diff).
    //
    // client.close() is called even though the transport already dropped so
    // any library-internal state (in-flight command promises, the closed
    // flag) settles consistently. The library treats double-close as a
    // no-op, so this is safe regardless of who initiated the drop.
    client.on("exit", (ev) => {
      if (follower.shuttingDown) return;
      follower.shuttingDown = true;
      console.warn(
        `[tmux-control] follower(${sessionId}) exited unexpectedly: ${ev.reason ?? "transport closed"}`,
      );
      this.followers.delete(sessionId);
      client.close();
      this.scheduleFollowerRespawn(sessionId);
    });

    // Same backpressure policy as primary so per-burst output pauses, then
    // self-resumes via the pause handler above.
    void client.setFlags(["pause-after=2"]).catch((err: unknown) => {
      console.error(
        `[tmux-control] follower(${sessionId}) setFlags failed:`,
        err,
      );
      this.tearDownFollower(sessionId, follower);
    });
  }

  // [LAW:single-enforcer] Every client (primary + followers) auto-resumes its
  // own paused panes so downstream consumers never need to know which client
  // emitted a pause — the wakeup happens at the source. Without this on the
  // primary the OutputRouter would have to plumb per-event source through to
  // call setPaneAction on the right client, and the consumer surface would
  // grow to absorb a concern that belongs here.
  private installPauseAutoResume(client: TmuxClient, label: string): void {
    client.on("pause", (msg) => {
      void client
        .setPaneAction(msg.paneId, PaneAction.Continue)
        .catch((err: unknown) => {
          console.error(
            `[tmux-control] ${label} auto-resume for pane %${msg.paneId} failed:`,
            err,
          );
        });
    });
  }

  // [LAW:single-enforcer] One scheduler per session — re-queuing the same
  // session cancels the prior timer. Idempotent and self-cancelling: if
  // observeSessions has already removed the session by the time the timer
  // fires, the body of the timer is a no-op.
  private scheduleFollowerRespawn(sessionId: SessionId): void {
    if (this.closed) return;
    if (!this.observed.has(sessionId)) return;
    this.cancelRespawn(sessionId);
    const timer = setTimeout(() => {
      this.respawnTimers.delete(sessionId);
      if (this.closed) return;
      if (!this.observed.has(sessionId)) return;
      if (this.followers.has(sessionId)) return;
      console.log(
        `[tmux-control] follower(${sessionId}) respawning after unexpected exit`,
      );
      this.spawnFollower(sessionId);
    }, this.followerRespawnDelayMs);
    this.respawnTimers.set(sessionId, timer);
  }

  private cancelRespawn(sessionId: SessionId): void {
    const timer = this.respawnTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.respawnTimers.delete(sessionId);
  }

  private tearDownFollower(
    sessionId: SessionId,
    follower: FollowerClient,
  ): void {
    if (follower.shuttingDown) return;
    follower.shuttingDown = true;
    // [LAW:single-enforcer] Detach every session-scoped listener that is
    // CURRENTLY registered — derived at teardown time so subscribe/unsubscribe
    // doesn't have to maintain a per-follower disposer list that grows stale.
    // A listener that was unsubscribed earlier was already removed from
    // `this.listeners`, so its off() never runs here (and a subsequent off()
    // on the library would be a harmless no-op anyway).
    for (const lst of this.listeners) {
      if (lst.scope !== "all") continue;
      follower.client.off(lst.event, lst.handler);
    }
    follower.client.close();
    this.followers.delete(sessionId);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
