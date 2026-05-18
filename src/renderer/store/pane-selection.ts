// [LAW:one-type-per-behavior] Loops UI state — selection, filter, view mode.
// The pane snapshot itself comes from `useTopology()` in src/renderer/tmux/proxy.ts
// (the canonical control-mode source). This store holds only what the UI owns:
// which pane the user picked, what they typed in the filter, which list shape
// they want.
import { create } from "zustand";
import type { PaneId } from "../../shared/types";

interface PaneSelectionStore {
  selectedPaneId: PaneId | null;
  filterText: string;
  viewMode: "tree" | "flat";
  selectPane: (id: PaneId | null) => void;
  setFilterText: (text: string) => void;
  setViewMode: (mode: "tree" | "flat") => void;
}

export const usePaneSelectionStore = create<PaneSelectionStore>((set) => ({
  selectedPaneId: null,
  filterText: "",
  viewMode: "tree",
  selectPane: (id) => set({ selectedPaneId: id }),
  setFilterText: (text) => set({ filterText: text }),
  setViewMode: (mode) => set({ viewMode: mode }),
}));
