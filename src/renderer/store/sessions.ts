import { create } from "zustand";
import type {
  Project,
  SessionInfo,
  MessageSummary,
  ProviderKind,
  ProviderUIMetadata,
  VersionInfo,
  DiffEntry,
  SessionSaveResult,
  SessionSearchResult,
  AnalyzerMetadata,
  AnalyzerResult,
  Pipeline,
  Step,
} from "../../shared/types";
import { cancelTask, newTaskId } from "./tasks";

interface SessionEditorState {
  // Tree view state
  projects: Project[];
  sessionsByProject: Record<string, SessionInfo[]>; // keyed by project.projectRoot
  expandedProjects: Set<string>;
  loadingProjects: Set<string>;

  // Provider UI metadata — loaded once, keyed by provider id
  providerMetadata: Record<string, ProviderUIMetadata>;

  // Editor state
  selectedSession: SessionInfo | null;
  selectedProjectPath: string | null;
  selectedProvider: ProviderKind | null;
  messages: MessageSummary[];
  markedForRemoval: Set<number>;
  previewIndex: number | null;
  previewContent: string;
  // Parsed JS object for the previewed message. Drives the structured
  // field-grid view. [LAW:one-source-of-truth] Adapter parses once.
  previewRaw: unknown;
  loading: boolean;
  saving: boolean;
  autoTrimIndices: number[];

  // Versioning state
  versions: VersionInfo[];
  versionHead: number;

  // Unified-pipeline state. analyzerMetadata is the catalog for the active
  // session's provider; analyzerResults caches each analyzer's last run output
  // keyed by analyzer id. pipeline.steps is the ordered list of accepted
  // operations the user has assembled.
  // [LAW:one-source-of-truth] analyzerResults always reflects the LAST run
  // for the current session. selectSession / undo / redo / restoreVersion
  // refire all analyzers and overwrite the cache.
  analyzerMetadata: AnalyzerMetadata[];
  analyzerResults: Record<string, AnalyzerResult>;
  analyzerRunning: Set<string>;
  pipeline: Pipeline;
  applying: boolean;

  // Search state. [LAW:dataflow-not-control-flow] searchResults drives the UI mode:
  // null = tree mode, array = search mode. No separate "isSearching" flag in the UI.
  searchQuery: string;
  searchResults: SessionSearchResult[] | null;
  searchStatus: "idle" | "running" | "done" | "error";
  searchError: string | null;
  searchTaskId: string | null;

  // Actions
  loadProjects: () => Promise<void>;
  toggleProject: (project: Project) => Promise<void>;
  selectSession: (session: SessionInfo, project: Project) => Promise<void>;
  // Deep-link entry: resolve (provider, sessionId) → (project, session) via
  // main, then delegate to selectSession. Same final state as clicking in the
  // tree, reached through a different input.
  selectSessionById: (
    provider: ProviderKind,
    sessionId: string,
  ) => Promise<boolean>;
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
  save: (force?: boolean) => Promise<SessionSaveResult>;

  // Versioning actions
  loadVersions: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  restoreVersion: (targetIdx: number) => Promise<void>;
  diffVersions: (fromIdx: number, toIdx: number) => Promise<DiffEntry[]>;

  // Pipeline actions
  runAnalyzer: (analyzerId: string) => Promise<void>;
  runAllAnalyzers: () => Promise<void>;
  addStep: (step: Omit<Step, "id">) => void;
  removeStep: (stepId: string) => void;
  clearPipeline: () => void;
  // `override` lets a caller apply a pipeline that ISN'T the stored one —
  // used by the legacy "Remove N & Save" shim which builds a one-off
  // pipeline including a transient manual remove step. Without the
  // override, repeat-clicking the shim button after a blocked apply
  // would queue duplicate stored steps. See handleSave in SessionEditor.
  applyPipeline: (
    force?: boolean,
    override?: Pipeline,
  ) => Promise<SessionSaveResult>;

  // Peek (non-destructive preview while search is open). peekResult is the
  // source of truth for "is the peek pane open?"; peekMessages is lazily
  // loaded via session:peek and caches the current peek's content.
  peekResult: SessionSearchResult | null;
  peekMessages: MessageSummary[] | null;
  peekLoading: boolean;
  peekError: string | null;

  // Search actions
  setSearchQuery: (query: string) => void;
  runSearch: (query: string) => Promise<void>;
  clearSearch: () => void;
  selectSearchResult: (result: SessionSearchResult) => Promise<void>;
  openPeek: (result: SessionSearchResult) => Promise<void>;
  closePeek: () => void;
}

const STORAGE_KEY = "session-editor-state";

interface PersistedSelection {
  session: SessionInfo;
  projectKey: string;
  provider: ProviderKind;
}

function persistSelection(
  session: SessionInfo | null,
  projectKey: string | null,
  provider: ProviderKind | null,
) {
  if (session && projectKey && provider) {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ session, projectKey, provider }),
    );
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

function loadPersistedSelection(): PersistedSelection | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// [LAW:single-enforcer] Subscribes to "session:tail" broadcasts and
// reloads the active session's messages whenever the file path the
// event names matches the currently selected session. Mounted once
// from App.tsx; returns its own unsub. No other code path consumes
// session:tail — the store IS the consumer.
//
// [LAW:dataflow-not-control-flow] One handler, one branch on data
// (does the event's filePath match the active session). Reload is
// unconditional once that branch is taken — the renderer doesn't ask
// "is this live-tail?" because the watcher only emits for live-tail
// files in the first place.
export function initSessionTailSubscription(): () => void {
  return window.electronAPI.on("session:tail", (...args: unknown[]) => {
    const payload = args[0] as { filePath: string; size: number };
    const state = useSessionStore.getState();
    const sel = state.selectedSession;
    const provider = state.selectedProvider;
    // selectedProvider tracks selectedSession 1:1 — both are set
    // together in selectSession and cleared together in clearSession,
    // so a non-null session implies a non-null provider. The narrow
    // is for the compiler; the invariant is the runtime guarantee.
    if (sel === null || provider === null) return;
    if (sel.filePath !== payload.filePath) return;
    void window.electronAPI
      .invoke("session:load", provider, sel.filePath)
      .then((messages) => {
        // Race: user may have switched sessions during the await.
        // Drop the response if so — otherwise we'd clobber the new
        // selection's messages with stale content.
        const after = useSessionStore.getState();
        if (after.selectedSession?.filePath !== sel.filePath) return;
        useSessionStore.setState({ messages: messages as MessageSummary[] });
      });
  });
}

export const useSessionStore = create<SessionEditorState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  expandedProjects: new Set(),
  loadingProjects: new Set(),

  providerMetadata: {},

  selectedSession: null,
  selectedProjectPath: null,
  selectedProvider: null,
  messages: [],
  markedForRemoval: new Set(),
  previewIndex: null,
  previewContent: "",
  previewRaw: null,
  loading: false,
  saving: false,
  autoTrimIndices: [],
  versions: [],
  versionHead: 0,
  analyzerMetadata: [],
  analyzerResults: {},
  analyzerRunning: new Set(),
  pipeline: { steps: [] },
  applying: false,

  searchQuery: "",
  searchResults: null,
  searchStatus: "idle",
  searchError: null,
  searchTaskId: null,

  peekResult: null,
  peekMessages: null,
  peekLoading: false,
  peekError: null,

  loadProjects: async () => {
    const [projects, providerMetadata] = await Promise.all([
      window.electronAPI.invoke("session:list-projects") as Promise<Project[]>,
      window.electronAPI.invoke("session:provider-metadata") as Promise<
        Record<string, ProviderUIMetadata>
      >,
    ]);
    set({ projects, providerMetadata });

    // Restore persisted selection
    const persisted = loadPersistedSelection();
    if (persisted) {
      const project = projects.find(
        (p) => p.projectRoot === persisted.projectKey,
      );
      if (project) {
        const expanded = new Set<string>([persisted.projectKey]);
        set({ expandedProjects: expanded });

        const sessions = (await window.electronAPI.invoke(
          "session:list-sessions",
          project.provider,
          project.paths,
        )) as SessionInfo[];
        set({
          sessionsByProject: { [persisted.projectKey]: sessions },
        });

        const match = sessions.find(
          (s) => s.sessionId === persisted.session.sessionId,
        );
        if (match) {
          get().selectSession(match, project);
        }
      }
    }
  },

  toggleProject: async (project) => {
    const { expandedProjects, sessionsByProject, loadingProjects } = get();
    const projectKey = project.projectRoot;

    if (expandedProjects.has(projectKey)) {
      const next = new Set(expandedProjects);
      next.delete(projectKey);
      set({ expandedProjects: next });
      return;
    }

    const nextExpanded = new Set(expandedProjects);
    nextExpanded.add(projectKey);
    set({ expandedProjects: nextExpanded });

    if (!sessionsByProject[projectKey]) {
      const nextLoading = new Set(loadingProjects);
      nextLoading.add(projectKey);
      set({ loadingProjects: nextLoading });

      const sessions = (await window.electronAPI.invoke(
        "session:list-sessions",
        project.provider,
        project.paths,
      )) as SessionInfo[];

      const doneLoading = new Set(get().loadingProjects);
      doneLoading.delete(projectKey);
      set({
        sessionsByProject: {
          ...get().sessionsByProject,
          [projectKey]: sessions,
        },
        loadingProjects: doneLoading,
      });
    }
  },

  selectSession: async (session, project) => {
    persistSelection(session, project.projectRoot, project.provider);
    set({
      selectedSession: session,
      selectedProjectPath: project.projectRoot,
      selectedProvider: project.provider,
      loading: true,
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      previewIndex: null,
      versions: [],
      versionHead: 0,
      analyzerMetadata: [],
      analyzerResults: {},
      analyzerRunning: new Set(),
      pipeline: { steps: [] },
      // [LAW:one-source-of-truth] A session switch is a full reset of
      // transient mutation flags. Without this, an in-flight applyPipeline
      // (or one that threw before its try/finally fires) leaves the new
      // session UI-disabled with no path to recover.
      applying: false,
    });
    const messages = (await window.electronAPI.invoke(
      "session:load",
      project.provider,
      session.filePath,
    )) as MessageSummary[];
    set({ messages, loading: false });
    // Load versions after the session is active (server-side coordinator needs the active path)
    await get().loadVersions();
    // [LAW:dataflow-not-control-flow] All analyzers fire on every session
    // load. No branching on provider here — the metadata list is empty for
    // providers with no registered analyzers, and runAllAnalyzers is a no-op.
    await get().runAllAnalyzers();
  },

  selectSessionById: async (provider, sessionId) => {
    const current = get().selectedSession;
    if (current?.sessionId === sessionId) return true;
    const found = (await window.electronAPI.invoke(
      "session:find",
      provider,
      sessionId,
    )) as { project: Project; session: SessionInfo } | null;
    if (!found) return false;
    // Make sure the project is registered so the tree reflects it too.
    const projects = get().projects;
    if (!projects.find((p) => p.projectRoot === found.project.projectRoot)) {
      set({ projects: [...projects, found.project] });
    }
    // Auto-expand the project so the tree shows where we landed.
    const expanded = new Set(get().expandedProjects);
    expanded.add(found.project.projectRoot);
    set({ expandedProjects: expanded });
    await get().selectSession(found.session, found.project);
    return true;
  },

  clearSession: () => {
    persistSelection(null, null, null);
    set({
      selectedSession: null,
      selectedProjectPath: null,
      selectedProvider: null,
      messages: [],
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      previewIndex: null,
      previewContent: "",
      versions: [],
      versionHead: 0,
      analyzerMetadata: [],
      analyzerResults: {},
      analyzerRunning: new Set(),
      pipeline: { steps: [] },
      // See selectSession reset — same reason.
      applying: false,
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
      if (msg.flags.includes(flag)) {
        next.add(msg.index);
      }
    }
    set({ markedForRemoval: next });
  },

  previewMessage: async (index) => {
    // Fetch raw and stringified content in parallel. [LAW:dataflow-not-control-flow]
    // Both travel together; the consumer picks the one it needs.
    const [content, raw] = await Promise.all([
      window.electronAPI.invoke(
        "session:message-content",
        index,
      ) as Promise<string>,
      window.electronAPI.invoke(
        "session:message-raw",
        index,
      ) as Promise<unknown>,
    ]);
    set({ previewIndex: index, previewContent: content, previewRaw: raw });
  },

  closePreview: () => {
    set({ previewIndex: null, previewContent: "", previewRaw: null });
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

  save: async (force = false) => {
    set({ saving: true });
    const indices = [...get().markedForRemoval];
    const result = await window.electronAPI.invoke(
      "session:save",
      indices,
      undefined,
      force,
    );
    // Blocked (validation OR live-tail): keep in-memory edit state intact
    // so the user can review the reason and either force-save, detach from
    // the live launch, or deselect problematic changes. No reload, no
    // version bump — the file on disk is untouched in either case.
    // [LAW:dataflow-not-control-flow] One check; the reason discriminator
    // is the renderer's concern, not the store's.
    if (result.blockedReason !== null) {
      set({ saving: false });
      return result;
    }
    // Reload the trimmed session — reuse active adapter (already set)
    const session = get().selectedSession;
    const provider = get().selectedProvider;
    if (session && provider) {
      const messages = (await window.electronAPI.invoke(
        "session:load",
        provider,
        session.filePath,
      )) as MessageSummary[];
      set({
        messages,
        markedForRemoval: new Set(),
        autoTrimIndices: [],
        saving: false,
      });
      await get().loadVersions();
    } else {
      set({ saving: false });
    }
    return result;
  },

  loadVersions: async () => {
    const meta = await window.electronAPI.invoke("session:list-versions");
    set({ versions: meta.versions, versionHead: meta.head });
  },

  undo: async () => {
    const messages = await window.electronAPI.invoke("session:undo");
    if (messages == null) return;
    set({
      messages,
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      pipeline: { steps: [] },
    });
    await get().loadVersions();
    await get().runAllAnalyzers();
  },

  redo: async () => {
    const messages = await window.electronAPI.invoke("session:redo");
    if (messages == null) return;
    set({
      messages,
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      pipeline: { steps: [] },
    });
    await get().loadVersions();
    await get().runAllAnalyzers();
  },

  restoreVersion: async (targetIdx: number) => {
    const messages = await window.electronAPI.invoke(
      "session:restore-version",
      targetIdx,
    );
    if (messages == null) return;
    set({
      messages,
      markedForRemoval: new Set(),
      autoTrimIndices: [],
      pipeline: { steps: [] },
    });
    await get().loadVersions();
    await get().runAllAnalyzers();
  },

  diffVersions: async (fromIdx: number, toIdx: number) => {
    return await window.electronAPI.invoke(
      "session:diff-versions",
      fromIdx,
      toIdx,
    );
  },

  // [LAW:single-enforcer] runAllAnalyzers is the only place that fetches the
  // catalog for the active session's provider. Individual runAnalyzer calls
  // reuse the cached metadata. Fires all in parallel — analyzers are pure
  // (read file, return result) so they don't share state.
  runAllAnalyzers: async () => {
    // [LAW:one-source-of-truth] Snapshot the session this catalog request
    // targets. A session-switch during the await must NOT cause us to
    // write analyzer state keyed to the wrong session/provider — mirrors
    // the stale-result guard in runAnalyzer.
    const startSession = get().selectedSession;
    const startProvider = get().selectedProvider;
    if (!startProvider || !startSession) return;
    const metadata = (await window.electronAPI.invoke(
      "session:list-analyzers",
      startProvider,
    )) as AnalyzerMetadata[];
    if (
      get().selectedSession?.filePath !== startSession.filePath ||
      get().selectedProvider !== startProvider
    ) {
      return;
    }
    set({
      analyzerMetadata: metadata,
      analyzerResults: {},
      analyzerRunning: new Set(metadata.map((m) => m.id)),
    });
    await Promise.all(metadata.map((m) => get().runAnalyzer(m.id)));
  },

  runAnalyzer: async (analyzerId) => {
    const session = get().selectedSession;
    if (!session) return;
    // [LAW:one-source-of-truth] Functional updates for the Set/object
    // membership so parallel runAnalyzer calls compose deterministically.
    // Read-snapshot-then-write would not race in current Zustand
    // (set is synchronous, no awaits between read and write), but the
    // functional form is robust to future refactors that might introduce
    // awaits in the middle of the update.
    set((state) => {
      const running = new Set(state.analyzerRunning);
      running.add(analyzerId);
      return { analyzerRunning: running };
    });
    try {
      const result = (await window.electronAPI.invoke(
        "session:run-analyzer",
        analyzerId,
        session.filePath,
      )) as AnalyzerResult;
      // Drop stale results: user may have switched session during the await.
      if (get().selectedSession?.filePath !== session.filePath) return;
      set((state) => {
        const running = new Set(state.analyzerRunning);
        running.delete(analyzerId);
        return {
          analyzerResults: { ...state.analyzerResults, [analyzerId]: result },
          analyzerRunning: running,
        };
      });
    } catch (err) {
      if (get().selectedSession?.filePath !== session.filePath) return;
      set((state) => {
        const running = new Set(state.analyzerRunning);
        running.delete(analyzerId);
        return { analyzerRunning: running };
      });
      // Surface the error so the dev sees it; analyzer failures are bugs.
      console.error(`Analyzer ${analyzerId} failed:`, err);
    }
  },

  addStep: (proposed) => {
    const step: Step = { ...proposed, id: crypto.randomUUID() };
    const pipeline = get().pipeline;
    set({ pipeline: { steps: [...pipeline.steps, step] } });
  },

  removeStep: (stepId) => {
    const pipeline = get().pipeline;
    set({
      pipeline: { steps: pipeline.steps.filter((s) => s.id !== stepId) },
    });
  },

  clearPipeline: () => {
    set({ pipeline: { steps: [] } });
  },

  applyPipeline: async (force = false, override?: Pipeline) => {
    // [LAW:one-source-of-truth] Capture the session this apply targets BEFORE
    // we await; any session-switch during the await is detected by comparing
    // selectedSession.filePath to this snapshot, and post-apply state writes
    // (reload, version bump, analyzer re-run) skip entirely if it changed.
    // This mirrors runAnalyzer's stale-result guard.
    const startSession = get().selectedSession;
    const startProvider = get().selectedProvider;
    const pipeline = override ?? get().pipeline;
    set({ applying: true });
    let result: SessionSaveResult;
    try {
      result = (await window.electronAPI.invoke(
        "session:apply-pipeline",
        pipeline,
        force,
      )) as SessionSaveResult;
    } catch (err) {
      // [LAW:single-enforcer] try/finally pattern: applying is the gate
      // that disables the Apply button; clearing it on every exit path
      // (including throws) is the single guarantee callers depend on.
      set({ applying: false });
      throw err;
    }

    // Stale guard: user switched sessions during the apply. Drop the
    // result entirely — the file we just wrote belongs to a session
    // that's no longer active, and the new session has its own loaded
    // state we mustn't clobber.
    const afterSession = get().selectedSession;
    if (afterSession?.filePath !== startSession?.filePath) {
      set({ applying: false });
      return result;
    }

    if (result.blockedReason !== null) {
      // Blocked = keep pipeline + selection state intact so the user can
      // review / resolve / retry. [LAW:dataflow-not-control-flow] The
      // renderer dispatches off blockedReason; the store doesn't care.
      set({ applying: false });
      return result;
    }

    if (startSession && startProvider) {
      const messages = (await window.electronAPI.invoke(
        "session:load",
        startProvider,
        startSession.filePath,
      )) as MessageSummary[];
      // Re-check stale after the reload await — runAnalyzer's pattern.
      if (get().selectedSession?.filePath !== startSession.filePath) {
        set({ applying: false });
        return result;
      }
      set({
        messages,
        markedForRemoval: new Set(),
        autoTrimIndices: [],
        pipeline: { steps: [] },
        applying: false,
      });
      await get().loadVersions();
      await get().runAllAnalyzers();
    } else {
      set({ applying: false });
    }
    return result;
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  // [LAW:single-enforcer] All content searches go through here. Cancels any
  // in-flight search before starting a new one — a mid-flight previous query
  // would otherwise land after the new one's results and silently overwrite them.
  // Subscribes to "session:search-batch" so results stream in as enrichment
  // completes, rather than the UI blocking on the full result set.
  runSearch: async (query) => {
    const trimmed = query.trim();

    // Cancel any in-flight search. Safe to call even if taskId is stale.
    const prevTaskId = get().searchTaskId;
    if (prevTaskId) {
      await cancelTask(prevTaskId).catch(() => undefined);
    }

    // Minimum length gate — below the threshold, we exit search mode entirely.
    if (trimmed.length < 2) {
      set({
        searchQuery: query,
        searchResults: null,
        searchStatus: "idle",
        searchError: null,
        searchTaskId: null,
      });
      return;
    }

    const taskId = newTaskId();
    // Start with an empty array (not null) so the UI enters search mode
    // immediately and can render batches as they arrive.
    set({
      searchQuery: query,
      searchResults: [],
      searchStatus: "running",
      searchError: null,
      searchTaskId: taskId,
    });

    // Subscribe to streaming batches for this task. Filter by taskId so a
    // batch from a now-cancelled earlier search can't land in the new one's
    // results — the main process keeps the taskId in the payload.
    // Results are kept sorted by lastUpdated desc at all times, including
    // during streaming. Same key as the main-process final sort so the list
    // ordering is stable across "arriving" → "done" transitions.
    const off = window.electronAPI.on(
      "session:search-batch",
      (...args: unknown[]) => {
        const payload = args[0] as {
          taskId: string;
          results: SessionSearchResult[];
        };
        if (payload.taskId !== taskId) return;
        if (get().searchTaskId !== taskId) return;
        const current = get().searchResults ?? [];
        const merged = [...current, ...payload.results];
        merged.sort(
          (a, b) =>
            new Date(b.lastUpdated).getTime() -
            new Date(a.lastUpdated).getTime(),
        );
        set({ searchResults: merged });
      },
    );

    try {
      const results = (await window.electronAPI.invoke(
        "session:search",
        taskId,
        trimmed,
      )) as SessionSearchResult[];
      // Drop late results if the user started another search or cleared.
      if (get().searchTaskId !== taskId) return;
      // Overwrite with the authoritative sorted final set. During streaming
      // results arrived in enrichment-completion order; this is the single
      // canonical "done" state.
      set({
        searchResults: results,
        searchStatus: "done",
        searchTaskId: null,
      });
    } catch (err) {
      if (get().searchTaskId !== taskId) return;
      set({
        searchStatus: "error",
        searchError: err instanceof Error ? err.message : String(err),
        searchTaskId: null,
      });
    } finally {
      off();
    }
  },

  clearSearch: () => {
    const prev = get().searchTaskId;
    if (prev) cancelTask(prev).catch(() => undefined);
    set({
      searchQuery: "",
      searchResults: null,
      searchStatus: "idle",
      searchError: null,
      searchTaskId: null,
      // Peek is a child of search state; clear together.
      peekResult: null,
      peekMessages: null,
      peekLoading: false,
      peekError: null,
    });
  },

  // Loads a session from a search result — skips the tree expansion path and
  // synthesizes the SessionInfo + Project from the result's embedded metadata.
  selectSearchResult: async (result) => {
    const synthesizedSession: SessionInfo = {
      sessionId: result.sessionId,
      filePath: result.filePath,
      summary: result.summary,
      startTime: "",
      lastUpdated: result.lastUpdated,
      messageCount: result.messageCount,
      fileSizeBytes: result.fileSizeBytes,
      previewMessages: [],
    };
    const synthesizedProject: Project = {
      name: result.projectName,
      paths: [],
      projectRoot: result.projectRoot,
      provider: result.provider,
    };
    // Clear search + peek state first so the UI exits search mode, then load.
    set({
      searchQuery: "",
      searchResults: null,
      searchStatus: "idle",
      searchError: null,
      searchTaskId: null,
      peekResult: null,
      peekMessages: null,
      peekLoading: false,
      peekError: null,
    });
    await get().selectSession(synthesizedSession, synthesizedProject);
  },

  // Load a session's messages via the stateless peek IPC (doesn't touch the
  // editor's active adapter). Safe to call repeatedly as the user flips
  // between results — we overwrite peekMessages with the latest load and
  // track a token to drop stale responses.
  openPeek: async (result) => {
    set({
      peekResult: result,
      peekMessages: null,
      peekLoading: true,
      peekError: null,
    });
    try {
      const messages = (await window.electronAPI.invoke(
        "session:peek",
        result.provider,
        result.filePath,
      )) as MessageSummary[];
      // Drop the response if the user has since closed or switched peek.
      if (get().peekResult?.filePath !== result.filePath) return;
      set({ peekMessages: messages, peekLoading: false });
    } catch (err) {
      if (get().peekResult?.filePath !== result.filePath) return;
      set({
        peekError: err instanceof Error ? err.message : String(err),
        peekLoading: false,
      });
    }
  },

  closePeek: () => {
    set({
      peekResult: null,
      peekMessages: null,
      peekLoading: false,
      peekError: null,
    });
  },
}));
