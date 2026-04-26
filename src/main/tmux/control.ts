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
import { tmuxExec } from "./exec";

export type ConnectionStatus = "connecting" | "ready" | "closed";

export interface ConnectionStateEvent {
  readonly status: ConnectionStatus;
  readonly reason?: string;
}

export interface TmuxControlConnectionOptions {
  // Transport factory — overridable for tests. Default attaches via the library.
  readonly transportFactory?: () => TmuxTransport;
  // Predicate to decide whether a tmux server is currently running. Default
  // shells `tmux has-session` once before each connect attempt. The control
  // ticket is explicit: do NOT auto-spawn a server. Without this check
  // `tmux -C` would create one.
  readonly serverProbe?: () => Promise<boolean>;
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

  private readonly transportFactory: () => TmuxTransport;
  private readonly serverProbe: () => Promise<boolean>;
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

  private constructor(options?: TmuxControlConnectionOptions) {
    this.transportFactory = options?.transportFactory ?? (() => spawnTmux([]));
    this.serverProbe = options?.serverProbe ?? defaultServerProbe;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 2000;
    this._ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  static start(
    options?: TmuxControlConnectionOptions,
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

  getState(): ConnectionStateEvent {
    return { status: this.status, reason: this.statusReason };
  }

  onConnectionState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener({ status: this.status, reason: this.statusReason });
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

    const serverRunning = await this.probeServer();
    if (this.closed) return;
    if (!serverRunning) {
      this.setStatus("closed", "no tmux server");
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

  private async probeServer(): Promise<boolean> {
    try {
      return await this.serverProbe();
    } catch (err) {
      // Probe blew up (e.g. tmux binary missing). Treat as no server and
      // back off — the next attempt will retry the probe.
      this.statusReason = errorMessage(err);
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelayMs);
  }

  private setStatus(status: ConnectionStatus, reason?: string): void {
    this.status = status;
    this.statusReason = reason;
    const event: ConnectionStateEvent = { status, reason };
    for (const listener of this.stateListeners) {
      listener(event);
    }
  }
}

async function defaultServerProbe(): Promise<boolean> {
  try {
    await tmuxExec(["has-session"]);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
