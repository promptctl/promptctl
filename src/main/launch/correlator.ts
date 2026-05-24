// [LAW:single-enforcer] Sole module that turns tmux events into launch
// registry mutations. The registry doesn't observe tmux directly; the
// correlator is the bridge. Two subscription channels feed in:
//
//  - Topology snapshots: pid correlation (pane.pid → launch.pid) and
//    tool-exit detection (pane.toolKind reverts to "unknown" / shell,
//    or the pane disappears from the snapshot entirely).
//  - Tmux `window-close` / `unlinked-window-close` events: a launched
//    window closing terminates its launch regardless of whether the
//    tool ever exited cleanly.
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

  // [LAW:dataflow-not-control-flow] One reconciliation function used by
  // every snapshot-driven trigger. The same loop body runs whether the
  // edge came from topology, registry, or post-reconnect refresh —
  // variability is the snapshot value, never which steps execute.
  //
  // Three outcomes per running row, gated on data:
  //   1. pane missing               → markExited "pane gone"
  //   2. pane.toolKind ≠ expected   → markExited "tool exited"
  //   3. otherwise                  → attach(pid) if newly known
  //
  // The registry's mutations are idempotent (markExited is terminal;
  // attach short-circuits on no-change), so duplicate snapshots don't
  // produce duplicate events.
  const reconcile = (snapshot: TmuxSnapshot): void => {
    for (const launch of deps.registry.listActive()) {
      if (launch.status !== "running") continue;
      const pane = snapshot.panes.find((p) => p.id === launch.paneId);
      if (!pane) {
        deps.registry.markExited(launch.launchId, "pane gone");
        continue;
      }
      if (pane.toolKind !== launch.toolKind) {
        // pane-cmd reverted to something other than the expected tool
        // (most commonly the shell that tmux launches the command
        // under). The tool process has exited.
        deps.registry.markExited(launch.launchId, "tool exited");
        continue;
      }
      if (pane.pid > 0) {
        deps.registry.attach(launch.launchId, { pid: pane.pid });
      }
    }
  };

  // ─── Snapshot-driven reconcile ────────────────────────────────────
  //
  // Two trigger edges feed the same function:
  //   1. Topology edge: a snapshot arrives (new-window, pane-pid
  //      subscription patch, refresh after reconnect). Walk running
  //      launches.
  //   2. Registry edge: a launch transitions to running. The relevant
  //      topology snapshot may already have fired before the row
  //      existed — pull the current snapshot now and reconcile.
  disposers.push(deps.onTopologySnapshot(reconcile));
  disposers.push(
    deps.registry.on((evt) => {
      if (evt.kind !== "updated" && evt.kind !== "created") return;
      reconcile(deps.getTopologySnapshot());
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
