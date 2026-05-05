// [LAW:one-source-of-truth] Sole producer of tmux-server state for the new
// event-driven path. Until 77e.1.3/.4 retire src/main/tmux/state.ts and output.ts,
// this connection runs in parallel with the legacy polling stack — both observe
// the same tmux server, only the legacy stack is wired to renderers today.
//
// [LAW:single-enforcer] Connect / reconnect / close transitions go through this
// class. Outside callers see a stable handle (`client`, `ready`, `on`) regardless
// of whether the underlying TmuxClient has been replaced after a reconnect.
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

  // The promptctl-owned session this connection is attached to. Stable for
  // the lifetime of the singleton; downstream consumers (topology tracker,
  // launch registry) read this to scope their observations.
  get ownedSessionName(): string {
    return this.sessionName;
  }

  get client(): TmuxClient | null {
    return this.currentClient;
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
