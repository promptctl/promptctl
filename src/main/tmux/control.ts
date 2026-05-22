// [LAW:one-source-of-truth] Sole producer of tmux-server state and the only
// channel through which the rest of the app drives tmux. Outside callers see a
// stable handle (`client`, `ready`, `on`) regardless of whether the underlying
// TmuxClient has been replaced after a reconnect.
//
// [LAW:single-enforcer] Connect / reconnect / close transitions go through this
// class — and so does the attached session. tmux delivers %output only for the
// session the control client is attached to, so "which session is attached" is
// a cross-cutting invariant: it gates what the output router, command engine,
// and renderer pane streams can observe. watchSession() is its only writer.
//
// [LAW:dataflow-not-control-flow] connect() runs the same sequence every
// invocation: setStatus("connecting") → spawn → register listeners → setFlags
// → setStatus("ready"). Failures flow into setStatus("closed", reason) and a
// scheduled reconnect — there is no branch that "skips" the lifecycle.

import {
  TmuxClient,
  spawnTmux,
  type TmuxEventMap,
  type TmuxTransport,
} from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
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
  // (creates if missing, attaches if it exists) before the control client
  // attaches. Required — every connection is scoped to a named session.
  readonly sessionName: string;
  // Transport factory — overridable for tests. Default spawns the control
  // client with `attach-session -t <sessionName>` baked in so tmux never
  // has the chance to create an anonymous session.
  readonly transportFactory?: () => TmuxTransport;
  // Bootstrap step: ensure the session exists. Default probes with
  // `tmux has-session -t =<name>` and creates with `tmux new-session -d
  // -s <name>` only if missing. Overridable for tests so unit suites
  // don't need a real tmux binary on PATH.
  readonly bootstrap?: () => Promise<void>;
  // Backoff between reconnect attempts.
  readonly reconnectDelayMs?: number;
}

type StateListener = (event: ConnectionStateEvent) => void;

// [LAW:dataflow-not-control-flow] Each subscription is stored as a
// `(client) => void` thunk pair. The generic `K` is captured at registration
// time inside the closure, so re-attaching after a reconnect doesn't need to
// reconstruct the type relationship between event name and handler signature.
interface PendingClientListener {
  readonly attach: (client: TmuxClient) => void;
  readonly detach: (client: TmuxClient) => void;
}

export class TmuxControlConnection {
  private static instance: TmuxControlConnection | null = null;

  private readonly sessionName: string;
  private readonly transportFactory: () => TmuxTransport;
  private readonly bootstrap: () => Promise<void>;
  private readonly reconnectDelayMs: number;
  private readonly stateListeners = new Set<StateListener>();
  private readonly clientListeners: PendingClientListener[] = [];

  private currentClient: TmuxClient | null = null;
  // [LAW:one-source-of-truth] The session the control client should be attached
  // to. `null` means the owned session (the bootstrap default). Re-applied on
  // every (re)connect so a transport drop never silently strands the client on
  // the owned session while the UI still believes it is watching another.
  private watchedSession: SessionId | null = null;
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
      (() => {
        // [LAW:single-enforcer] All transport spawns route through here so
        // the `attach-session -t <name>` argv is never bypassed — that's
        // what prevents tmux from inventing an anonymous session.
        const args = ["attach-session", "-t", sessionName];
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

  get client(): TmuxClient | null {
    return this.currentClient;
  }

  // [LAW:single-enforcer] The only writer of the attached session. Loops and
  // the debug surface express intent ("watch this pane's session"); this method
  // records it and switches the live client. `null` reverts to the owned
  // session. The intent survives reconnects because connect() re-applies it on
  // ready — the renderer cannot do this itself since it never sees the drop.
  async watchSession(sessionId: SessionId | null): Promise<void> {
    this.watchedSession = sessionId;
    const client = this.currentClient;
    // [LAW:no-defensive-null-guards] currentClient is genuinely optional while
    // (re)connecting; the intent is recorded above and connect() applies it on
    // ready, so an early return here defers the work — it never drops it.
    if (client === null) return;
    await this.applyWatchedSession(client);
  }

  // [LAW:dataflow-not-control-flow] Always switches to the resolved target
  // (watched session, else owned). On first connect that target is the owned
  // session the argv already attached to — an idempotent no-op — so the same
  // line runs on every ready transition without a "did the user pick a session"
  // branch.
  //
  // [LAW:no-silent-fallbacks] A failed switch to a foreign watched session
  // (killed while we were detached) reverts to the owned session, which the
  // bootstrap guarantees exists — but the fallback's success is checked. A
  // swallowed failure would let connect() reach `ready` with the client
  // unattached, silently killing %output delivery; instead it throws so connect
  // routes through the reconnect path. When the target already WAS the owned
  // session there is no fallback, so the failure surfaces directly.
  private async applyWatchedSession(client: TmuxClient): Promise<void> {
    const target = this.watchedSession ?? this.sessionName;
    const resp = await client.execute(`switch-client -t ${tmuxEscape(target)}`);
    if (resp.success) return;
    if (this.watchedSession === null) {
      throw new Error(
        `switch-client to owned session ${target} failed: ${resp.output.join("\n")}`,
      );
    }
    this.watchedSession = null;
    const owned = await client.execute(
      `switch-client -t ${tmuxEscape(this.sessionName)}`,
    );
    if (!owned.success) {
      throw new Error(
        `switch-client to owned session ${this.sessionName} failed: ${owned.output.join("\n")}`,
      );
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

  // Subscribe to a TmuxClient event in a reconnect-safe way. The handler is
  // re-registered on every new client instance, so callers don't need to
  // re-subscribe themselves after a transport drop.
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): () => void {
    const entry: PendingClientListener = {
      attach: (client) => client.on(event, handler),
      detach: (client) => client.off(event, handler),
    };
    this.clientListeners.push(entry);
    if (this.currentClient !== null) entry.attach(this.currentClient);
    return () => {
      const idx = this.clientListeners.indexOf(entry);
      if (idx >= 0) this.clientListeners.splice(idx, 1);
      if (this.currentClient !== null) entry.detach(this.currentClient);
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.currentClient;
    this.currentClient = null;
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

    const client = this.spawnClient();
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
      await this.applyWatchedSession(client);
    } catch (err) {
      this.handleClientFailure(client, errorMessage(err));
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

  private spawnClient(): TmuxClient | null {
    let transport: TmuxTransport;
    try {
      transport = this.transportFactory();
    } catch (err) {
      this.setStatus("closed", errorMessage(err));
      this.scheduleReconnect();
      return null;
    }

    const client = new TmuxClient(transport);
    this.currentClient = client;
    for (const entry of this.clientListeners) {
      entry.attach(client);
    }
    client.on("exit", (ev) =>
      this.handleClientFailure(client, ev.reason ?? "transport closed"),
    );
    return client;
  }

  private handleClientFailure(client: TmuxClient, reason: string): void {
    if (this.currentClient !== client) return; // stale event from a prior client
    this.currentClient = null;
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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
