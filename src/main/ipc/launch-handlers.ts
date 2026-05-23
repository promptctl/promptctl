// [LAW:single-enforcer] One IPC site for the launch registry. Reads
// (`launch:list`, `launch:get`) and subscribe (`launch:subscribe` +
// push `launch:event` / `launch:list`) come from the registry's
// projection. The lone mutating channel — `launch:create` — delegates
// to the spawn flow which is the only constructor of launch rows
// (`launch:terminate` lands when the Workshop tab needs it).
//
// [LAW:one-source-of-truth] All payloads project off the registry — no
// caching at the IPC boundary. The handler is a thin pass-through.

import { ipcMain, type WebContents } from "electron";
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
  // The spawn flow's other dependencies (tmux client, topology, proxy
  // port). The handler hands them through verbatim — it has no opinions
  // beyond plumbing.
  readonly spawn: Omit<SpawnDeps, "registry">;
}

export function registerLaunchHandlers(deps: LaunchHandlerDeps): () => void {
  const { registry } = deps;
  const subscribers = new Set<WebContents>();

  ipcMain.on("launch:subscribe", (event) => {
    // [LAW:dataflow-not-control-flow] Same hook every time a renderer
    // attaches: add to the set, send the current snapshot, schedule
    // removal on destroy. No "is this the first subscriber" branch.
    subscribers.add(event.sender);
    event.sender.send("launch:list", registry.list());
    event.sender.once("destroyed", () => subscribers.delete(event.sender));
  });

  ipcMain.handle("launch:list", () => registry.list());

  ipcMain.handle(
    "launch:get",
    (_e, launchId: LaunchId): Launch | null => registry.get(launchId),
  );

  // [LAW:single-enforcer] One IPC entry to spawn a tagged launch. The
  // renderer's LaunchToolDialog calls this; nothing else creates rows.
  ipcMain.handle(
    "launch:create",
    (_e, spec: LaunchSpec): Promise<Launch> =>
      spawnLaunch({ registry, ...deps.spawn }, spec),
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
    ipcMain.removeHandler("launch:list");
    ipcMain.removeHandler("launch:get");
    ipcMain.removeHandler("launch:create");
    subscribers.clear();
  };
}
