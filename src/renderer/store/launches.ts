// [LAW:one-source-of-truth] Renderer mirror of the main-process
// LaunchRegistry. Updates flow in via "launch:list" + "launch:event"
// pushes — the renderer never tracks launch state out-of-band.
//
// [LAW:dataflow-not-control-flow] Two pushes per mutation: the event
// (delta) and the list (steady-state). The store always projects off
// the list — the event is exposed for views that want to react to
// transitions (toasts, focus-on-create) but is never the canonical
// source of "which launches exist."

import { create } from "zustand";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  PaneId,
  WindowId,
} from "../../shared/types";

interface LaunchStore {
  launches: Launch[];
  lastEvent: LaunchEvent | null;
  setLaunches: (launches: Launch[]) => void;
  setLastEvent: (event: LaunchEvent) => void;
  byId: (id: LaunchId) => Launch | undefined;
  byPane: (paneId: PaneId) => Launch | undefined;
  byWindow: (windowId: WindowId) => Launch | undefined;
}

export const useLaunchStore = create<LaunchStore>((set, get) => ({
  launches: [],
  lastEvent: null,
  setLaunches: (launches) => set({ launches }),
  setLastEvent: (event) => set({ lastEvent: event }),
  byId: (id) => get().launches.find((l) => l.launchId === id),
  byPane: (paneId) =>
    get().launches.find((l) => l.paneId === paneId && l.status !== "exited"),
  byWindow: (windowId) =>
    get().launches.find(
      (l) => l.windowId === windowId && l.status !== "exited",
    ),
}));

export async function initLaunchSubscription(): Promise<() => void> {
  // Seed the store with the current registry snapshot before attaching
  // the push listeners — eliminates an "empty → populated" repaint
  // when launches are already present at boot. (Note: this still runs
  // from App's useEffect, so the very first render happens with an
  // empty store; consumers that mount before this resolves see the
  // launches on the next render once setLaunches lands.)
  const initial = (await window.electronAPI.invoke("launch:list")) as Launch[];
  useLaunchStore.getState().setLaunches(initial);

  const unsubList = window.electronAPI.on("launch:list", (launches) => {
    useLaunchStore.getState().setLaunches(launches);
  });
  const unsubEvents = window.electronAPI.on("launch:event", (event) => {
    useLaunchStore.getState().setLastEvent(event);
  });

  window.electronAPI.send("launch:subscribe");

  return () => {
    unsubList();
    unsubEvents();
    // Detach on the main side too so the WebContents stops receiving
    // launch:list / launch:event pushes. Without this the cleanup only
    // removes renderer-side listeners and main keeps sending — fine for
    // a single app-wide subscriber that lives for the WebContents'
    // lifetime, misleading when the subscription is mounted/unmounted.
    window.electronAPI.send("launch:unsubscribe");
  };
}
