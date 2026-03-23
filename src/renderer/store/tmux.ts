// [LAW:one-source-of-truth] Derived projection of main process tmux state.
import { create } from "zustand";
import type { TmuxSnapshot, PaneId } from "../../shared/types";

interface TmuxStore {
  snapshot: TmuxSnapshot;
  selectedPaneId: PaneId | null;
  filterText: string;
  viewMode: "tree" | "flat";
  setSnapshot: (snapshot: TmuxSnapshot) => void;
  selectPane: (id: PaneId | null) => void;
  setFilterText: (text: string) => void;
  setViewMode: (mode: "tree" | "flat") => void;
}

export const useTmuxStore = create<TmuxStore>((set) => ({
  snapshot: { timestamp: 0, panes: [] },
  selectedPaneId: null,
  filterText: "",
  viewMode: "tree",
  setSnapshot: (snapshot) => set({ snapshot }),
  selectPane: (id) => set({ selectedPaneId: id }),
  setFilterText: (text) => set({ filterText: text }),
  setViewMode: (mode) => set({ viewMode: mode }),
}));

// Initialize subscription to main process
export function initTmuxSubscription(): () => void {
  const unsub = window.electronAPI.on("tmux:snapshot", (snapshot) => {
    useTmuxStore.getState().setSnapshot(snapshot as TmuxSnapshot);
  });

  window.electronAPI.send("tmux:subscribe");

  return () => {
    unsub();
    window.electronAPI.send("tmux:unsubscribe");
  };
}
