import { create } from "zustand";
import type { PaneId, PaneOutputChunk } from "../../shared/types";

const MAX_BUFFER_SIZE = 100_000; // characters per pane

interface PaneOutputStore {
  buffers: Record<string, string>;
  appendChunk: (chunk: PaneOutputChunk) => void;
  clearBuffer: (paneId: PaneId) => void;
}

export const usePaneOutputStore = create<PaneOutputStore>((set) => ({
  buffers: {},
  appendChunk: (chunk) =>
    set((state) => {
      const existing = state.buffers[chunk.paneId] ?? "";
      let updated = existing + chunk.data;
      // Trim from front if over limit
      if (updated.length > MAX_BUFFER_SIZE) {
        updated = updated.slice(updated.length - MAX_BUFFER_SIZE);
      }
      return { buffers: { ...state.buffers, [chunk.paneId]: updated } };
    }),
  clearBuffer: (paneId) =>
    set((state) => {
      return {
        buffers: Object.fromEntries(
          Object.entries(state.buffers).filter(([key]) => key !== paneId),
        ),
      };
    }),
}));

export function initOutputSubscription(): () => void {
  return window.electronAPI.on("tmux:pane-output", (chunk) => {
    usePaneOutputStore
      .getState()
      .appendChunk(chunk as PaneOutputChunk);
  });
}
