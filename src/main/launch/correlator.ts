// [LAW:single-enforcer] Sole module that turns tmux events into launch
// registry mutations. The registry doesn't observe tmux directly; the
// correlator is the bridge. Three subscription channels feed in:
//
//  - Topology snapshots: pid correlation (pane.pid → launch.pid) and
//    tool-exit detection (pane.toolKind reverts to "unknown" / shell).
//  - Tmux `window-close` events: a launched window closing terminates
//    its launch regardless of whether the tool ever exited cleanly.
//  - Control-connection state transitions: tmux server dropping out
//    marks every running launch exited.
//
// All three funnel through the registry's transition methods; the
// correlator never constructs Launch values, only signals them.
//
// [LAW:dataflow-not-control-flow] Each subscription runs the same
// pipeline on every event: read current state, project to the affected
// launch row, hand to the registry. No "is this a first-time signal"
// branches — the registry's idempotent attach/markExited absorb repeats.

import type { TmuxEventMap } from "tmux-control-mode-js";
import type { TmuxSnapshot } from "../../shared/types";
import type { ConnectionStateEvent } from "../tmux/control";
import type { LaunchRegistry } from "./registry";

export interface CorrelatorDeps {
  readonly registry: LaunchRegistry;
  // Subscription seam mirroring TmuxTopologyTracker.onSnapshot. The
  // tracker delivers an initial snapshot synchronously on attach, so
  // the correlator picks up the state-of-the-world right away.
  readonly onTopologySnapshot: (
    listener: (snapshot: TmuxSnapshot) => void,
  ) => () => void;
  // Pull the current topology snapshot on demand. Needed because a
  // launch may be registered AFTER the relevant topology snapshot has
  // already fired — without an on-demand read the correlator would
  // have to wait for the next snapshot edge to attach the pid.
  readonly getTopologySnapshot: () => TmuxSnapshot;
  // Reconnect-safe tmux event subscription (TmuxControlConnection.on
  // in production — re-registers on every reconnect).
  readonly onTmuxEvent: <K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ) => () => void;
  // Connection-state notifications (TmuxControlConnection.onConnectionState).
  readonly onConnectionState: (
    listener: (state: ConnectionStateEvent) => void,
  ) => () => void;
}

export function startLaunchCorrelator(deps: CorrelatorDeps): () => void {
  const disposers: (() => void)[] = [];

  // [LAW:dataflow-not-control-flow] One reconciliation function used by
  // every trigger. Either input source (topology edge / registry edge)
  // calls it with the current snapshot — same code path either way.
  const reconcilePid = (snapshot: TmuxSnapshot): void => {
    for (const launch of deps.registry.listRunning()) {
      if (launch.status !== "running") continue;
      const pane = snapshot.panes.find((p) => p.id === launch.paneId);
      if (!pane || pane.pid <= 0) continue;
      deps.registry.attach(launch.launchId, { pid: pane.pid });
    }
  };

  // ─── PID correlation ──────────────────────────────────────────────
  //
  // Two triggers feed the same reconciliation:
  //   1. Topology edge: a snapshot arrives (new-window, pane-pid
  //      subscription patch). Walk running launches; attach pid.
  //   2. Registry edge: a launch transitions to running. The relevant
  //      topology snapshot may already have fired before the row
  //      existed — pull the current snapshot now and reconcile.
  // The registry's attach is idempotent on no-change, so the two
  // triggers can fire in either order without doubling.
  disposers.push(deps.onTopologySnapshot(reconcilePid));
  disposers.push(
    deps.registry.on((evt) => {
      if (evt.kind !== "updated" && evt.kind !== "created") return;
      reconcilePid(deps.getTopologySnapshot());
    }),
  );

  return () => {
    for (const d of disposers) d();
  };
}

