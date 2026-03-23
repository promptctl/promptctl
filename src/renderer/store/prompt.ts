import { create } from "zustand";
import type { Prompt, PromptId } from "../../shared/types";

interface PromptStore {
  prompts: Prompt[];
  selectedId: PromptId | null;
  setPrompts: (prompts: Prompt[]) => void;
  select: (id: PromptId | null) => void;
  load: () => Promise<void>;
  save: (prompt: Prompt) => Promise<void>;
  remove: (filename: string) => Promise<void>;
}

export const usePromptStore = create<PromptStore>((set) => ({
  prompts: [],
  selectedId: null,
  setPrompts: (prompts) => set({ prompts }),
  select: (id) => set({ selectedId: id }),
  load: async () => {
    const prompts = (await window.electronAPI.invoke("prompt:list")) as Prompt[];
    set({ prompts });
  },
  save: async (prompt) => {
    const prompts = (await window.electronAPI.invoke("prompt:save", prompt)) as Prompt[];
    set({ prompts });
  },
  remove: async (filename) => {
    const prompts = (await window.electronAPI.invoke(
      "prompt:delete",
      filename,
    )) as Prompt[];
    set((state) => ({
      prompts,
      selectedId: state.selectedId
        ? prompts.some((p) => p.id === state.selectedId)
          ? state.selectedId
          : null
        : null,
    }));
  },
}));
