// [LAW:one-source-of-truth] Sole authoritative source of launch identity.
// Every other tab (Loops, Live, Workshop, Workshop-tab) reads launches
// from here — none keep their own copy.
//
// [LAW:single-enforcer] Mutation paths funneled through this module.
// Three transition methods: markRunning (pending→running), attach*
// (in-place updates on running rows), markExited (any→exited). One
// internal `update` helper bumps the map, persists, and emits — every
// mutation flows through it so nothing skips persistence or events.
//
// [LAW:dataflow-not-control-flow] The registry runs the same pipeline on
// every mutation: produce-next-row → write-to-map → enqueue-persist →
// emit. The variability is the next-row value; the pipeline is fixed.
//
// [LAW:no-defensive-null-guards] Transition methods return `null` when
// the launch is gone or in the wrong state — that is the legitimate
// signal for the caller (a stray subscription event that arrived after
// markExited, for example). We do not silently no-op and pretend the
// mutation happened.

import type {
  Launch,
  LaunchEvent,
  LaunchId,
  LaunchPending,
  LaunchRunning,
  LaunchSpec,
  PaneId,
  SessionId,
  ToolLaunchKind,
  WindowId,
} from "../../shared/types";

type LaunchListener = (event: LaunchEvent) => void;

// Saver is injected so unit tests can swap in a no-op or an in-memory
// stub. Production wires this to persistence.saveLaunches.
export type LaunchSaver = (launches: readonly Launch[]) => Promise<void>;

export interface LaunchRegistryOptions {
  // Pre-seeded rows from persistence. Pass `[]` for a fresh registry;
  // pass `await loadLaunches()` to restore.
  readonly initial?: readonly Launch[];
  // Persistence sink. Defaults to a no-op so unit tests that only care
  // about the in-memory shape don't need to mock file I/O.
  readonly save?: LaunchSaver;
  // Clock — overridable for deterministic tests.
  readonly now?: () => number;
  // ID generator — overridable for deterministic tests.
  readonly newId?: () => LaunchId;
}

// Fields that arrive after a launch has been created. Used to keep
// `attach*` methods narrow: the registry knows which field maps to
// which late-binding signal; callers never construct partial Launch
// objects themselves.
export interface LaunchAttachFields {
  readonly pid?: number;
  readonly proxyClientId?: string;
  readonly sessionFilePath?: string;
}

// Concrete fields the registry needs to record a created launch.
// paneId/sessionId/windowId are resolved by the spawn flow after
// new-session; env is the exact set of vars we injected.
//
// launchId is optional: the spawn flow generates the ID up front
// (because it has to embed it in the env block before new-session
// runs), so it supplies the ID at create time. Callers that don't
// need the ID early can omit it and the registry mints one via
// the injected newId() factory.
export interface LaunchCreateInputs {
  readonly spec: LaunchSpec;
  readonly paneId: PaneId;
  readonly sessionId: SessionId;
  readonly windowId: WindowId;
  readonly env: Readonly<Record<string, string>>;
  readonly launchId?: LaunchId;
}

export class LaunchRegistry {
  private readonly launches = new Map<LaunchId, Launch>();
  private readonly listeners = new Set<LaunchListener>();
  private readonly save: LaunchSaver;
  private readonly now: () => number;
  private readonly newId: () => LaunchId;

  // Persistence coalescer: at most one save in flight; a mutation that
  // lands while a save is running flips `pending`, and we re-save the
  // latest snapshot when the in-flight save resolves. This guarantees
  // the on-disk state converges to the in-memory state without piling
  // up overlapping writes.
  private saveInFlight = false;
  private savePending = false;

  constructor(options: LaunchRegistryOptions = {}) {
    this.save = options.save ?? (async () => undefined);
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => crypto.randomUUID() as LaunchId);
    for (const launch of options.initial ?? []) {
      this.launches.set(launch.launchId, launch);
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────

  list(): readonly Launch[] {
    return [...this.launches.values()];
  }

  get(launchId: LaunchId): Launch | null {
    return this.launches.get(launchId) ?? null;
  }

  on(handler: LaunchListener): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  // ─── Mutations ────────────────────────────────────────────────────

  // Create a launch in `pending` state. The spawn flow calls this after
  // resolving paneId/sessionId/windowId from `new-session`, then waits
  // for the pane-cmd subscription to confirm the tool actually started
  // before calling markRunning.
  create(inputs: LaunchCreateInputs): LaunchPending {
    const row: LaunchPending = {
      launchId: inputs.launchId ?? this.newId(),
      toolKind: inputs.spec.toolKind,
      paneId: inputs.paneId,
      sessionId: inputs.sessionId,
      windowId: inputs.windowId,
      cwd: inputs.spec.cwd,
      startedAt: this.now(),
      env: inputs.env,
      status: "pending",
    };
    this.update("created", row);
    return row;
  }

  // Transition pending → running. Idempotent: calling on an already-
  // running row is a no-op (returns the row); calling on an exited row
  // returns null — pane-cmd events can race exit detection, and the
  // exited state is terminal.
  markRunning(launchId: LaunchId): LaunchRunning | null {
    const current = this.launches.get(launchId);
    if (!current) return null;
    if (current.status === "exited") return null;
    if (current.status === "running") return current;
    const next: LaunchRunning = {
      ...current,
      status: "running",
      pid: null,
      proxyClientId: null,
      sessionFilePath: null,
    };
    this.update("updated", next);
    return next;
  }

  // Late-binding field updates. Only meaningful on a running row — the
  // type narrowing ensures we never wrote them to a pending row.
  // Calling on a non-running row returns null and is a noop.
  attach(launchId: LaunchId, fields: LaunchAttachFields): LaunchRunning | null {
    const current = this.launches.get(launchId);
    if (!current) return null;
    if (current.status !== "running") return null;
    const next: LaunchRunning = {
      ...current,
      pid: fields.pid ?? current.pid,
      proxyClientId: fields.proxyClientId ?? current.proxyClientId,
      sessionFilePath: fields.sessionFilePath ?? current.sessionFilePath,
    };
    // Avoid emitting an updated event when nothing actually changed —
    // protects subscribers from spurious re-renders when the same
    // subscription value arrives twice.
    if (
      next.pid === current.pid &&
      next.proxyClientId === current.proxyClientId &&
      next.sessionFilePath === current.sessionFilePath
    ) {
      return current;
    }
    this.update("updated", next);
    return next;
  }

  // Final transition. Idempotent on already-exited rows (returns the
  // existing exited row unchanged — same `exitedAt`, same reason —
  // because the first exit reason is the truth and subsequent triggers
  // are redundant signals). Three call sites in production: pane-cmd
  // reverts to a shell, %window-close fires, tmux server exits.
  markExited(launchId: LaunchId, reason: string): Launch | null {
    const current = this.launches.get(launchId);
    if (!current) return null;
    if (current.status === "exited") return current;
    // Carry forward pid/proxyClientId/sessionFilePath when present —
    // they're not in LaunchCommon, so we have to project off status.
    const carry =
      current.status === "running"
        ? {
            pid: current.pid,
            proxyClientId: current.proxyClientId,
            sessionFilePath: current.sessionFilePath,
          }
        : { pid: null, proxyClientId: null, sessionFilePath: null };
    const next: Launch = {
      launchId: current.launchId,
      toolKind: current.toolKind,
      paneId: current.paneId,
      sessionId: current.sessionId,
      windowId: current.windowId,
      cwd: current.cwd,
      startedAt: current.startedAt,
      env: current.env,
      status: "exited",
      exitedAt: this.now(),
      exitReason: reason,
      ...carry,
    };
    this.update("exited", next);
    return next;
  }

  // ─── Lookups used by tabs/correlation ─────────────────────────────

  // O(n) scan — N is small (one row per launched tool ever, exited rows
  // included). When N gets large enough to matter we add a paneId
  // index; today it doesn't.
  findByPane(paneId: PaneId): Launch | null {
    for (const launch of this.launches.values()) {
      if (launch.paneId === paneId && launch.status !== "exited") {
        return launch;
      }
    }
    return null;
  }

  findByWindow(windowId: WindowId): Launch | null {
    for (const launch of this.launches.values()) {
      if (launch.windowId === windowId && launch.status !== "exited") {
        return launch;
      }
    }
    return null;
  }

  // Used by exit detection when the tmux server drops out — every
  // running launch is then known to be unreachable.
  listRunning(): readonly Launch[] {
    const out: Launch[] = [];
    for (const launch of this.launches.values()) {
      if (launch.status !== "exited") out.push(launch);
    }
    return out;
  }

  // Used by tool-kind correlation when resolving a tool process by pid
  // (recovery, process-tree linking). Returns the most recent match.
  findByPid(pid: number): Launch | null {
    let best: Launch | null = null;
    for (const launch of this.launches.values()) {
      if (launch.status !== "exited" && launch.status !== "pending") {
        if (launch.pid === pid) {
          if (best === null || launch.startedAt > best.startedAt) {
            best = launch;
          }
        }
      }
    }
    return best;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private update(kind: LaunchEvent["kind"], launch: Launch): void {
    this.launches.set(launch.launchId, launch);
    this.schedulePersist();
    const event: LaunchEvent = { kind, launch };
    // Materialize before iteration so a handler that calls back into
    // create/markExited doesn't perturb the listener set mid-loop.
    for (const handler of [...this.listeners]) handler(event);
  }

  private schedulePersist(): void {
    if (this.saveInFlight) {
      this.savePending = true;
      return;
    }
    void this.runPersist();
  }

  private async runPersist(): Promise<void> {
    this.saveInFlight = true;
    try {
      // Loop until no further mutation has landed during a save —
      // guarantees the on-disk file converges to the latest in-memory
      // state without piling up overlapping writers.
      // [LAW:dataflow-not-control-flow] One loop body, no branching.
      while (true) {
        const snapshot = [...this.launches.values()];
        this.savePending = false;
        await this.save(snapshot);
        if (!this.savePending) return;
      }
    } finally {
      this.saveInFlight = false;
    }
  }

  // Test seam: flush in-flight persistence so assertions can race a
  // mutation against the next save deterministically.
  async __flushForTesting(): Promise<void> {
    while (this.saveInFlight || this.savePending) {
      // Yield to the microtask queue so the in-flight persist can run.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

// Sentinel used in tests when a deterministic ID generator is convenient.
export function deterministicIdSequence(prefix: string): () => LaunchId {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}` as LaunchId;
  };
}

// Sentinel used by spawn to produce the env block we inject. Kept here
// so the registry and spawn never disagree about which keys they care
// about. The proxy port comes from the proxy manager at call time.
export function launchEnvBlock(args: {
  readonly launchId: LaunchId;
  readonly proxyPort: number;
  readonly toolKind: ToolLaunchKind;
}): Record<string, string> {
  const base: Record<string, string> = {
    PROMPTCTL_LAUNCH_ID: args.launchId,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${args.proxyPort}`,
    ANTHROPIC_CUSTOM_HEADERS: `X-Promptctl-Launch: ${args.launchId}`,
  };
  // [LAW:dataflow-not-control-flow] toolKind is data we record so
  // downstream consumers (recovery, header dispatch) can confirm the
  // launch matched the binary we expected. No per-tool branches here.
  return { ...base, PROMPTCTL_LAUNCH_TOOL: args.toolKind };
}
