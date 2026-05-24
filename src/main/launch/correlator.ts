// [LAW:single-enforcer] Sole module that turns tmux events into launch
// registry mutations. The registry doesn't observe tmux directly; the
// correlator is the bridge. Two subscription channels feed in:
//
//  - Topology snapshots: pid correlation (pane.pid → launch.pid) and
//    exit detection (pane disappears from the snapshot entirely).
//  - Tmux `window-close` / `unlinked-window-close` events: a launched
//    window closing terminates its launch regardless of whether tmux
//    has refreshed the topology yet.
//
// Control-connection state transitions are deliberately NOT wired —
// see the note at the bottom of startLaunchCorrelator: distinguishing
// "tmux server died" from "promptctl shutting down" inside a state
// listener is brittle, and the recovery flow at app start is the
// canonical reconciliation. The onConnectionState dep remains in the
// interface as a placeholder for the future reconnect-driven refresh.
//
// Both wired channels funnel through the registry's transition methods;
// the correlator never constructs Launch values, only signals them.
//
// [LAW:dataflow-not-control-flow] Each subscription runs the same
// pipeline on every event: read current state, project to the affected
// launch row, hand to the registry. No "is this a first-time signal"
// branches — the registry's idempotent attach/markExited absorb repeats.
//
// [LAW:types-are-the-program] Exit detection is shaped around signals
// that tmux emits uniformly across configurations: a pane disappearing
// from the topology, and the `window-close` event. We deliberately do
// NOT compare pane.toolKind against launch.toolKind: under shell-wrap
// configurations pane_current_command reports the wrapping shell or
// wrapper-script interpreter, which would make the predicate false
// throughout the launch's life and force a phantom-exit on the first
// snapshot. The strongest theorem we can write about "the launch has
// exited" is "tmux no longer shows its pane."

import type { TmuxEventMap } from "tmux-control-mode-js";
import type { TmuxSnapshot, WindowId } from "../../shared/types";
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
  // Connection-state notifications. Currently unused — slice E will
  // attach a recovery-on-reconnect handler here. Kept in the interface
  // so the wiring in main.ts is stable across slices.
  readonly onConnectionState: (
    listener: (state: ConnectionStateEvent) => void,
  ) => () => void;
}

export function startLaunchCorrelator(deps: CorrelatorDeps): () => void {
  const disposers: (() => void)[] = [];

  // [LAW:one-type-per-behavior] Two distinct triggers, two distinct
  // functions — what feels like a single "reconcile" actually carries
  // two unrelated meanings, and collapsing them produced phantom-exits
  // under trust-spawn (the snapshot in hand at the moment markRunning
  // fires can pre-date the new-session's window-add — making the pane
  // legitimately absent from a stale view, NOT actually gone).
  //
  //  - Topology edge → reconcileFromSnapshot:
  //      The snapshot is the world's truth at the moment it fires
  //      (it came from a list-panes triggered by a tmux topology
  //      event). Absent pane in this snapshot is real exit.
  //
  //  - Registry edge → attachFromSnapshot:
  //      A launch row was just created/updated; the snapshot we have
  //      may have been taken before the launch's pane existed. Use
  //      this edge ONLY to attach late-arriving pid info; never to
  //      decide exit. The next topology edge — which we have a real
  //      reason to believe is post-spawn — owns exit detection.

  // [LAW:dataflow-not-control-flow] reconcileFromSnapshot runs the same
  // pipeline on every topology edge: read snapshot, project to running
  // rows, two outcomes gated on data (pane missing → markExited; pane
  // present → attach pid). Registry idempotency absorbs repeats.
  const reconcileFromSnapshot = (snapshot: TmuxSnapshot): void => {
    for (const launch of deps.registry.listActive()) {
      if (launch.status !== "running") continue;
      const pane = snapshot.panes.find((p) => p.id === launch.paneId);
      if (!pane) {
        deps.registry.markExited(launch.launchId, "pane gone");
        continue;
      }
      if (pane.pid > 0) {
        deps.registry.attach(launch.launchId, { pid: pane.pid });
      }
    }
  };

  const attachFromSnapshot = (snapshot: TmuxSnapshot): void => {
    for (const launch of deps.registry.listActive()) {
      if (launch.status !== "running") continue;
      const pane = snapshot.panes.find((p) => p.id === launch.paneId);
      if (pane !== undefined && pane.pid > 0) {
        deps.registry.attach(launch.launchId, { pid: pane.pid });
      }
    }
  };

  disposers.push(deps.onTopologySnapshot(reconcileFromSnapshot));
  disposers.push(
    deps.registry.on((evt) => {
      if (evt.kind !== "updated" && evt.kind !== "created") return;
      attachFromSnapshot(deps.getTopologySnapshot());
    }),
  );

  // ─── Direct window-close → markExited ────────────────────────────
  //
  // tmux emits window-close with the numeric window id (display form
  // is "@<n>", which is what LaunchEntity.windowId carries). The
  // snapshot reconcile above will also catch this on the next refresh,
  // but the direct signal is faster and tied to the originating event.
  // [LAW:single-enforcer] Both routes call the same markExited.
  const closeHandler = (event: { windowId: number }): void => {
    const windowId = `@${event.windowId}` as WindowId;
    for (const launch of deps.registry.listActive()) {
      if (launch.windowId === windowId) {
        deps.registry.markExited(launch.launchId, "window closed");
      }
    }
  };
  disposers.push(deps.onTmuxEvent("window-close", closeHandler));
  // Unlinked windows are not currently displayed in any session — same
  // termination semantics for our purposes.
  disposers.push(deps.onTmuxEvent("unlinked-window-close", closeHandler));

  // Note: server-died (connection state → "closed") is intentionally
  // NOT a trigger here. Distinguishing "tmux server died" from
  // "promptctl is shutting down" inside a state listener is brittle,
  // and the recovery flow at app start (slice E) is the canonical
  // reconciliation against the OS process table. Slice E will wire
  // the reconnect-driven refresh through the same `reconcile` above.
  return () => {
    for (const d of disposers) d();
  };
}
