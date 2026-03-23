import { create } from "zustand";
import type {
  GeminiProject,
  GeminiSessionInfo,
  GeminiMessageSummary,
} from "../../shared/types";

interface SessionEditorState {
  // Tree view state
  projects: GeminiProject[];
  sessionsByProject: Record<string, GeminiSessionInfo[]>; // keyed by project.path
  expandedProjects: Set<string>;
  loadingProjects: Set<string>;

  // Editor state
  selectedSession: GeminiSessionInfo | null;
  selectedProjectPath: string | null;
  messages: GeminiMessageSummary[];
  markedForRemoval: Set<number>;
  previewIndex: number | null;
  previewContent: string;
  loading: boolean;
  saving: boolean;
  autoTrimIndices: number[];

  // Actions
  loadProjects: () => Promise<void>;
  toggleProject: (projectPath: string) => Promise<void>;
  selectSession: (session: GeminiSessionInfo, projectPath: string) => Promise<void>;
  clearSession: () => void;
  toggleMessage: (index: number) => void;
  toggleRange: (startIndex: number, endIndex: number) => void;
  selectAll: () => void;
  deselectAll: () => void;
  selectFlagged: (flag: string) => void;
  previewMessage: (index: number) => Promise<void>;
  closePreview: () => void;
  runAutoTrim: () => Promise<void>;
  applyAutoTrim: () => void;
  save: () => Promise<string>;
}

export const useSessionStore = create<SessionEditorState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  expandedProjects: new Set(),
  loadingProjects: new Set(),

  selectedSession: null,
  selectedProjectPath: null,
  messages: [],
  markedForRemoval: new Set(),
  previewIndex: null,
  previewContent: "",
  loading: false,
  saving: false,
  autoTrimIndices: [],

  loadProjects: async () => {
    const projects = (await window.electronAPI.invoke(
      "session:list-projects",
    )) as GeminiProject[];
    set({ projects });
  },

  toggleProject: async (projectPath) => {
    const { expandedProjects, sessionsByProject, loadingProjects } = get();

    if (expandedProjects.has(projectPath)) {
      const next = new Set(expandedProjects);
      next.delete(projectPath);
      set({ expandedProjects: next });
      return;
    }

    // Expand and load sessions if not already loaded
    const nextExpanded = new Set(expandedProjects);
    nextExpanded.add(projectPath);
    set({ expandedProjects: nextExpanded });

    if (!sessionsByProject[projectPath]) {
      const nextLoading = new Set(loadingProjects);
      nextLoading.add(projectPath);
      set({ loadingProjects: nextLoading });

      const sessions = (await window.electronAPI.invoke(
        "session:list-sessions",
        projectPath,
      )) as GeminiSessionInfo[];

      const doneLoading = new Set(get().loadingProjects);
      doneLoading.delete(projectPath);
      set({
        sessionsByProject: { ...get().sessionsByProject, [projectPath]: sessions },
        loadingProjects: doneLoading,
      });
    }
  },

  selectSession: async (session, projectPath) => {
    set({
      selectedSession: session,
      selectedProjectPath: projectPath,
      loading: true,
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      previewIndex: null,
    });
    const messages = (await window.electronAPI.invoke(
      "session:load",
      session.filePath,
    )) as GeminiMessageSummary[];
    set({ messages, loading: false });
  },

  clearSession: () => {
    set({
      selectedSession: null,
      selectedProjectPath: null,
      messages: [],
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      previewIndex: null,
      previewContent: "",
    });
  },

  toggleMessage: (index) => {
    const next = new Set(get().markedForRemoval);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    set({ markedForRemoval: next });
  },

  toggleRange: (startIndex, endIndex) => {
    const next = new Set(get().markedForRemoval);
    const lo = Math.min(startIndex, endIndex);
    const hi = Math.max(startIndex, endIndex);
    const adding = !next.has(lo);
    for (let i = lo; i <= hi; i++) {
      if (adding) next.add(i);
      else next.delete(i);
    }
    set({ markedForRemoval: next });
  },

  selectAll: () => {
    set({ markedForRemoval: new Set(get().messages.map((m) => m.index)) });
  },

  deselectAll: () => {
    set({ markedForRemoval: new Set() });
  },

  selectFlagged: (flag) => {
    const next = new Set(get().markedForRemoval);
    for (const msg of get().messages) {
      if (msg.flags.includes(flag as GeminiMessageSummary["flags"][number])) {
        next.add(msg.index);
      }
    }
    set({ markedForRemoval: next });
  },

  previewMessage: async (index) => {
    const content = (await window.electronAPI.invoke(
      "session:message-content",
      index,
    )) as string;
    set({ previewIndex: index, previewContent: content });
  },

  closePreview: () => {
    set({ previewIndex: null, previewContent: "" });
  },

  runAutoTrim: async () => {
    const indices = (await window.electronAPI.invoke(
      "session:auto-trim",
    )) as number[];
    set({ autoTrimIndices: indices });
  },

  applyAutoTrim: () => {
    const next = new Set(get().markedForRemoval);
    for (const i of get().autoTrimIndices) next.add(i);
    set({ markedForRemoval: next });
  },

  save: async () => {
    set({ saving: true });
    const indices = [...get().markedForRemoval];
    const result = (await window.electronAPI.invoke(
      "session:save",
      indices,
    )) as string;
    // Reload the trimmed session
    const session = get().selectedSession;
    if (session) {
      const messages = (await window.electronAPI.invoke(
        "session:load",
        session.filePath,
      )) as GeminiMessageSummary[];
      set({
        messages,
        markedForRemoval: new Set(),
        autoTrimIndices: [],
        saving: false,
      });
    } else {
      set({ saving: false });
    }
    return result;
  },
}));
