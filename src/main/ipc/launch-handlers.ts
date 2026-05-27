// [LAW:single-enforcer] One IPC site for the launch registry. Reads
// (`launch:list`, `launch:get`) and subscribe (`launch:subscribe` +
// push `launch:event` / `launch:list`) come from the registry's
// projection. Mutating channels — `launch:create` and `launch:terminate`
// — both flow through this module. Creation funnels into the spawn flow,
// the sole constructor of launch rows; termination kills the launch's
// tmux session and lets the correlator's existing pane-gone /
// window-close path call markExited.
//
// [LAW:one-source-of-truth] All payloads project off the registry — no
// caching at the IPC boundary. The handler is a thin pass-through.

import { ipcMain, type WebContents } from "electron";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import type { CommandResponse } from "tmux-control-mode-js/protocol";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  LaunchSpec,
} from "../../shared/types";
import type { LaunchRegistry } from "../launch/registry";
import { spawnLaunch, type SpawnDeps } from "../launch/spawn";

export interface LaunchHandlerDeps {
  readonly registry: LaunchRegistry;
  // Tmux executor — used by both `launch:create` (via spawn) and
  // `launch:terminate` (kill-session). Hoisted out of `spawn` so a
  // single owner plumbs it from main, and terminate doesn't have to
  // reach into spawn-shaped deps for the same primitive.
  readonly execute: (command: string) => Promise<CommandResponse>;
  // The spawn flow's other dependencies (proxy port, optional test
  // seams). Plumbed through verbatim — the handler has no opinions.
  readonly spawn: Omit<SpawnDeps, "registry" | "execute">;
}

export function registerLaunchHandlers(deps: LaunchHandlerDeps): () => void {
  const { registry } = deps;
  const subscribers = new Set<WebContents>();

  ipcMain.on("launch:subscribe", (event) => {
    // Resend the current snapshot on every subscribe (a re-subscribe
    // after HMR or remount should see fresh state), but register the
    // destroyed listener exactly once per WebContents — `once` itself
    // doesn't dedupe, so repeated subscribe cycles would otherwise
    // pile up pending listeners against the same sender. The set's
    // membership is the right guard: first add returns "was new",
    // re-add is the repeat case.
    const isNew = !subscribers.has(event.sender);
    subscribers.add(event.sender);
    if (isNew) {
      event.sender.once("destroyed", () => subscribers.delete(event.sender));
    }
    event.sender.send("launch:list", registry.list());
  });

  // Explicit unsubscribe so the renderer's `initLaunchSubscription`
  // cleanup actually stops main-side pushes. Without this the WebContents
  // would only fall out of the set on destruction — fine for an app-
  // wide subscription but misleading when the React tree mounts/unmounts
  // the subscriber (e.g. under HMR). [LAW:single-enforcer] one ipcMain
  // listener per direction.
  ipcMain.on("launch:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });

  ipcMain.handle("launch:list", () => registry.list());

  ipcMain.handle("launch:get", (_e, launchId: LaunchId): Launch | null =>
    registry.get(launchId),
  );

  // [LAW:single-enforcer] One IPC entry to spawn a tagged launch. The
  // renderer's LaunchToolDialog calls this; nothing else creates rows.
  ipcMain.handle(
    "launch:create",
    (_e, spec: LaunchSpec): Promise<Launch> =>
      spawnLaunch({ registry, execute: deps.execute, ...deps.spawn }, spec),
  );

  // [LAW:single-enforcer] One IPC entry to stop a tagged launch. The
  // handler does not call markExited directly — the correlator's
  // existing pane-gone / window-close path is the sole transition
  // owner. We kill the tmux session and let the broadcast loop fire
  // the natural way; the renderer sees the same `exited` event it
  // would see for any other exit reason.
  //
  // The return value carries the discriminator the caller acts on:
  //  - `null`            → no row in the registry for that id.
  //  - row.status="exited" → already terminal; we did NOT issue a
  //    fresh kill-session, since exit is terminal and the correlator's
  //    idempotent markExited is the sole owner of that transition.
  //  - row.status="pending"|"running" → kill-session was sent. The
  //    correlator's window-close / pane-gone path will flip the row
  //    to exited and broadcast over the registry's event stream;
  //    callers that need the post-kill state subscribe to launch:event
  //    rather than waiting on this return.
  // [LAW:no-defensive-null-guards] No silent no-ops on any input —
  // every case has a distinguishable return shape.
  ipcMain.handle(
    "launch:terminate",
    async (_e, launchId: LaunchId): Promise<Launch | null> => {
      const launch = registry.get(launchId);
      if (launch === null) return null;
      if (launch.status === "exited") return launch;
      // tmux's `kill-session -t <session-id>` accepts the `$N` form
      // directly. Each launch lives in its own session (spawn creates
      // one per launch), so killing the session terminates the whole
      // launch — pane, window, and any tool process still inside.
      await deps.execute(`kill-session -t ${tmuxEscape(launch.sessionId)}`);
      return launch;
    },
  );

  const unsubRegistry = registry.on((evt: LaunchEvent) => {
    // Two broadcasts per mutation: the event itself (so subscribers can
    // react to deltas without diffing) and the new list (so subscribers
    // that only care about the steady-state shape get the full picture).
    const snapshot = registry.list();
    for (const wc of subscribers) {
      if (wc.isDestroyed()) continue;
      wc.send("launch:event", evt);
      wc.send("launch:list", snapshot);
    }
  });

  return () => {
    unsubRegistry();
    ipcMain.removeAllListeners("launch:subscribe");
    ipcMain.removeAllListeners("launch:unsubscribe");
    ipcMain.removeHandler("launch:list");
    ipcMain.removeHandler("launch:get");
    ipcMain.removeHandler("launch:create");
    ipcMain.removeHandler("launch:terminate");
    subscribers.clear();
  };
}
