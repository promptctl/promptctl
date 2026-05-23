// [LAW:single-enforcer] One IPC site for the launch registry. The renderer
// invokes (launch:list, launch:get) for reads and subscribes to launch:event
// for push updates. Mutating channels (launch:create, launch:terminate)
// land in later slices; this slice registers the read+subscribe surface.
//
// [LAW:one-source-of-truth] All payloads project off the registry — no
// caching at the IPC boundary. The handler is a thin pass-through.

import { ipcMain, type WebContents } from "electron";
import type { Launch, LaunchEvent, LaunchId } from "../../shared/types";
import type { LaunchRegistry } from "../launch/registry";

export function registerLaunchHandlers(registry: LaunchRegistry): () => void {
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
    subscribers.clear();
  };
}
