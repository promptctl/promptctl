import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { setupUser } from "../../test/user-event";
import { SessionEditor } from "./SessionEditor";
import { useSessionStore } from "../store/sessions";
import {
  installElectronMock,
  setInvokeHandlers,
  type MockElectronAPI,
} from "../../test/electron-mock";
import type {
  MessageSummary,
  SessionInfo,
  VersionInfo,
  SessionSearchResult,
} from "../../shared/types";

let api: MockElectronAPI;

function makeMessage(index: number, type = "user"): MessageSummary {
  return {
    index,
    id: `m${index}`,
    type,
    timestamp: "",
    tokens: 100,
    preview: `message ${index}`,
    hasToolCalls: false,
    hasToolResults: false,
    toolNames: [],
    flags: [],
    extras: {},
  };
}

function makeSession(): SessionInfo {
  return {
    sessionId: "test-session",
    filePath: "/test/session.jsonl",
    summary: "Test Session",
    startTime: "2025-01-01T00:00:00Z",
    lastUpdated: "2025-01-01T00:01:00Z",
    messageCount: 2,
    fileSizeBytes: 100,
    previewMessages: ["hello"],
  };
}

function makeVersions(count: number): VersionInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i + 1,
    ts: "2025-01-01T00:00:00Z",
    label: `Version ${i + 1}`,
    sizeBytes: 100,
    tokensTotal: 50,
  }));
}

/**
 * Set up the store as if a session is loaded with the given messages and versions.
 * Bypasses the normal selectSession flow so tests can focus on UI behavior.
 */
function setStoreLoaded(opts: {
  messages?: MessageSummary[];
  versions?: VersionInfo[];
  versionHead?: number;
}) {
  useSessionStore.setState({
    selectedSession: makeSession(),
    selectedProjectPath: "/test",
    selectedProvider: "claude",
    messages: opts.messages ?? [makeMessage(0), makeMessage(1)],
    versions: opts.versions ?? [],
    versionHead: opts.versionHead ?? 0,
    providerMetadata: {
      claude: {
        badge: { label: "Claude", color: "" },
        typeStyles: {
          user: { label: "User", color: "" },
        },
        flagDefinitions: {},
        helpText: {
          description: "",
          resumeCommand: "",
          safeToRemove: [],
          beCareful: [],
        },
      },
    },
  });
}

beforeEach(() => {
  api = installElectronMock();
  // Default IPC handlers — mount-time calls SessionEditor fires. Individual
  // tests layer additional/overriding handlers on top via setInvokeHandlers.
  setInvokeHandlers(api, {
    "session:list-projects": () => [],
    "session:provider-metadata": () => ({}),
    "settings:load": () => ({
      openaiApiKey: "",
      openaiModel: "gpt-5.4",
      lastRoute: "/workshop",
      compressSummarizeThreshold: 5000,
      compressTruncateThreshold: 1000,
      compressKeepLastN: 3,
    }),
    "session:list-versions": () => ({
      sessionPath: "",
      provider: "claude",
      head: 0,
      versions: [],
    }),
  });
  // Reset store
  useSessionStore.setState({
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
    searchQuery: "",
    searchResults: null,
    searchStatus: "idle",
    searchError: null,
    searchTaskId: null,
  });
});

function makeSearchResult(
  overrides: Partial<SessionSearchResult> = {},
): SessionSearchResult {
  return {
    provider: "claude",
    projectName: "my-project",
    projectRoot: "/fake/root",
    sessionId: "sess-1",
    filePath: "/fake/root/sess-1.jsonl",
    summary: "About oscilla naga",
    lastUpdated: "2025-01-01T00:00:00Z",
    messageCount: 10,
    fileSizeBytes: 5000,
    totalMatches: 2,
    matchesTruncated: false,
    matches: [
      {
        lineNumber: 3,
        messageRole: "user",
        snippet: "prefix oscilla naga suffix",
        matchStart: 7,
        matchEnd: 19,
      },
      {
        lineNumber: 5,
        messageRole: "assistant",
        snippet: "reply about oscilla naga shim",
        matchStart: 12,
        matchEnd: 24,
      },
    ],
    ...overrides,
  };
}

describe("Undo button", () => {
  it("is disabled when versionHead is 0 (no versions)", async () => {
    setStoreLoaded({ versions: [], versionHead: 0 });
    render(<SessionEditor />);
    const undoBtn = screen.getByTestId("undo-button");
    expect((undoBtn as HTMLButtonElement).disabled).toBe(true);
    cleanup();
  });

  it("is disabled when versionHead is 1 (already at first version)", async () => {
    setStoreLoaded({ versions: makeVersions(1), versionHead: 1 });
    render(<SessionEditor />);
    expect(
      (screen.getByTestId("undo-button") as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
  });

  it("is enabled when versionHead > 1", async () => {
    setStoreLoaded({ versions: makeVersions(3), versionHead: 3 });
    render(<SessionEditor />);
    expect(
      (screen.getByTestId("undo-button") as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
  });

  it("invokes store.undo when clicked", async () => {
    const user = setupUser();
    setStoreLoaded({ versions: makeVersions(2), versionHead: 2 });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:undo": () => [makeMessage(0)],
      "session:list-versions": () => ({
        sessionPath: "/test",
        provider: "claude",
        head: 1,
        versions: makeVersions(2),
      }),
    });

    render(<SessionEditor />);
    await user.click(screen.getByTestId("undo-button"));

    expect(api.invoke).toHaveBeenCalledWith("session:undo");
    cleanup();
  });
});

describe("Redo button", () => {
  it("is disabled when versionHead is at tip", async () => {
    setStoreLoaded({ versions: makeVersions(3), versionHead: 3 });
    render(<SessionEditor />);
    expect(
      (screen.getByTestId("redo-button") as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
  });

  it("is enabled when versionHead < tip", async () => {
    setStoreLoaded({ versions: makeVersions(3), versionHead: 1 });
    render(<SessionEditor />);
    expect(
      (screen.getByTestId("redo-button") as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
  });

  it("invokes store.redo when clicked", async () => {
    const user = setupUser();
    setStoreLoaded({ versions: makeVersions(3), versionHead: 1 });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:redo": () => [makeMessage(0)],
      "session:list-versions": () => ({
        sessionPath: "/test",
        provider: "claude",
        head: 2,
        versions: makeVersions(3),
      }),
    });

    render(<SessionEditor />);
    await user.click(screen.getByTestId("redo-button"));

    expect(api.invoke).toHaveBeenCalledWith("session:redo");
    cleanup();
  });
});

describe("History button", () => {
  it("shows the version count", async () => {
    setStoreLoaded({ versions: makeVersions(5), versionHead: 5 });
    render(<SessionEditor />);
    expect(screen.getByTestId("history-button").textContent).toContain(
      "History (5)",
    );
    cleanup();
  });

  it("is always enabled (even with no versions)", async () => {
    setStoreLoaded({ versions: [], versionHead: 0 });
    render(<SessionEditor />);
    expect(
      (screen.getByTestId("history-button") as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
  });

  it("opens the history pane inside a resizable split next to the main panel", async () => {
    setStoreLoaded({ versions: makeVersions(2), versionHead: 2 });
    setInvokeHandlers(api, {
      "session:list-versions": () => ({
        sessionPath: "",
        provider: "claude",
        head: 2,
        versions: makeVersions(2),
      }),
    });
    render(<SessionEditor />);
    const user = setupUser();
    await user.click(screen.getByTestId("history-button"));
    expect(screen.getByTestId("session-editor-history-split")).toBeTruthy();
    expect(screen.getByTestId("version-history-panel")).toBeTruthy();
    expect(
      screen.getByTestId("session-editor-history-split-second"),
    ).toHaveStyle({ width: "320px" });
    cleanup();
  });
});

describe("Backup confirmation dialog removed", () => {
  it("Save proceeds without calling window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    setStoreLoaded({ messages: [makeMessage(0), makeMessage(1)] });
    useSessionStore.setState({ markedForRemoval: new Set([0]) });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:save": () => ({
        path: "/test/session.jsonl",
        violations: [],
        forced: false,
        blocked: false,
      }),
      "session:load": () => [makeMessage(0)],
      "session:list-versions": () => ({
        sessionPath: "/test",
        provider: "claude",
        head: 2,
        versions: makeVersions(2),
      }),
    });

    const user = setupUser();
    render(<SessionEditor />);

    // The Save button text reflects pending removals: "Remove N & Save"
    const saveBtn = screen.getByText(/Remove .* & Save/i);
    await user.click(saveBtn);

    // Confirm should NOT have been called (backup dialog removed)
    expect(confirmSpy).not.toHaveBeenCalled();
    // session:save should have been invoked with (indices, outputPath, force)
    expect(api.invoke).toHaveBeenCalledWith(
      "session:save",
      [0],
      undefined,
      false,
    );

    confirmSpy.mockRestore();
    cleanup();
  });

  it("does NOT invoke session:check-backup", async () => {
    setStoreLoaded({ messages: [makeMessage(0)] });
    useSessionStore.setState({ markedForRemoval: new Set([0]) });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:save": () => ({
        path: "/test/session.jsonl",
        violations: [],
        forced: false,
        blocked: false,
      }),
      "session:load": () => [],
      "session:list-versions": () => ({
        sessionPath: "/test",
        provider: "claude",
        head: 2,
        versions: makeVersions(2),
      }),
    });

    const user = setupUser();
    render(<SessionEditor />);
    await user.click(screen.getByText(/Remove .* & Save/i));

    expect(api.invoke).not.toHaveBeenCalledWith("session:check-backup");
    cleanup();
  });
});

describe("Task toast — Compress Tools", () => {
  it("shows the task toast with a cancel button while compression is in progress", async () => {
    setStoreLoaded({
      messages: [
        makeMessage(0, "user"),
        makeMessage(1, "tool-result"),
        makeMessage(2, "tool-result"),
        makeMessage(3, "tool-result"),
        makeMessage(4, "tool-result"),
      ],
    });

    let resolve: (v: unknown) => void = () => {
      // Placeholder replaced synchronously by the Promise executor below.
    };
    const pending = new Promise((r) => {
      resolve = r;
    });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": () => ({
        openaiApiKey: "",
        openaiModel: "gpt-5.4",
        lastRoute: "/loops",
        compressSummarizeThreshold: 5000,
        compressTruncateThreshold: 1000,
        compressKeepLastN: 3,
      }),
      "session:compress-tools": () => pending,
    });

    const user = setupUser();
    render(<SessionEditor />);
    await user.click(screen.getByText("Compress Tools"));

    // The toast mounts with a placeholder "running" state as soon as the
    // handler sets activeTaskId — before any task:event fires.
    const toast = await screen.findByTestId("task-toast");
    expect(toast).toBeTruthy();
    // Cancel button is present while running.
    expect(screen.getByTestId("task-toast-cancel")).toBeTruthy();

    resolve({
      updated: [makeMessage(1, "tool-result")],
      truncatedCount: 1,
      summarizedCount: 0,
      skippedTooSmall: 1,
      skippedProtected: 3,
    });

    cleanup();
  });

  it("toast renders the post-run summary after the compress handler resolves", async () => {
    setStoreLoaded({
      messages: [makeMessage(0, "tool-result")],
    });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": () => ({
        openaiApiKey: "",
        openaiModel: "gpt-5.4",
        lastRoute: "/loops",
        compressSummarizeThreshold: 5000,
        compressTruncateThreshold: 1000,
        compressKeepLastN: 3,
      }),
      "session:compress-tools": () => ({
        updated: [],
        truncatedCount: 0,
        summarizedCount: 0,
        skippedTooSmall: 2,
        skippedProtected: 3,
      }),
    });

    const user = setupUser();
    render(<SessionEditor />);
    await user.click(screen.getByText("Compress Tools"));

    // Handler-owned outcome is the source of truth — no fake events needed.
    // Assert the summary appears in the toast content once the invoke settles.
    await screen.findByText(/No tool results modified/);
    const toast = screen.getByTestId("task-toast");
    expect(toast.textContent).toContain("2 too small");
    expect(toast.textContent).toContain("3 preserved");

    cleanup();
  });
});

describe("Full-text session search", () => {
  // Driving the debounce via real timers + fireEvent (no userEvent internal
  // delays). Simpler and avoids the fake-timers / userEvent hang that we hit
  // earlier in this test file.

  it("debounces keystrokes and invokes session:search once", async () => {
    const searchCall = vi.fn(async () => [makeSearchResult()]);
    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:search": searchCall,
    });

    render(<SessionEditor />);
    const input = screen.getByLabelText("Search session content");
    // Three rapid keystrokes; debounce should collapse to one call.
    fireEvent.change(input, { target: { value: "o" } });
    fireEvent.change(input, { target: { value: "os" } });
    fireEvent.change(input, { target: { value: "osc" } });

    // Wait for the 300ms debounce + a little slack for the invoke to fire.
    await waitFor(
      () => {
        const calls = api.invoke.mock.calls.filter(
          (c) => c[0] === "session:search",
        );
        expect(calls.length).toBe(1);
      },
      { timeout: 1500 },
    );
    const searchCalls = api.invoke.mock.calls.filter(
      (c) => c[0] === "session:search",
    );
    expect(searchCalls[0][2]).toBe("osc");

    cleanup();
  });

  it("does not search for queries shorter than 2 chars", async () => {
    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:search": vi.fn(),
    });

    render(<SessionEditor />);
    const input = screen.getByLabelText("Search session content");
    fireEvent.change(input, { target: { value: "a" } });

    // Wait a bit longer than the debounce window.
    await new Promise((r) => setTimeout(r, 500));

    const searchCalls = api.invoke.mock.calls.filter(
      (c) => c[0] === "session:search",
    );
    expect(searchCalls).toHaveLength(0);

    cleanup();
  });

  it("renders search results with highlighted snippets", async () => {
    useSessionStore.setState({
      searchQuery: "oscilla naga",
      searchResults: [makeSearchResult()],
      searchStatus: "done",
      providerMetadata: {
        claude: {
          badge: { label: "Claude", color: "" },
          typeStyles: {},
          flagDefinitions: {},
          helpText: {
            description: "",
            resumeCommand: "",
            safeToRemove: [],
            beCareful: [],
          },
        },
      },
    });

    render(<SessionEditor />);

    // Summary / project header are visible (getByText throws if not found).
    expect(screen.getByText("About oscilla naga")).not.toBeNull();
    expect(screen.getByText("my-project")).not.toBeNull();

    // The snippet's matched substring is rendered inside a <mark> tag.
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThanOrEqual(1);
    const texts = Array.from(marks).map((m) => m.textContent);
    expect(texts.some((t) => t?.includes("oscilla naga"))).toBe(true);

    cleanup();
  });

  it("renders results in the main panel, not the sidebar, while keeping the tree visible", async () => {
    useSessionStore.setState({
      searchQuery: "x",
      searchResults: [makeSearchResult()],
      searchStatus: "done",
      // Provide one project so the tree renders something identifiable
      projects: [
        {
          name: "tree-project",
          paths: [],
          projectRoot: "/tree/root",
          provider: "claude",
        },
      ],
    });

    render(<SessionEditor />);

    // The sidebar lives inside the resizable split; locate it via testid.
    const sidebar = screen.getByTestId("session-editor-sidebar");

    // The tree is still present in the sidebar.
    expect(sidebar.textContent).toContain("tree-project");

    // The search-result summary is rendered OUTSIDE the sidebar (in the main panel).
    const resultNode = screen.getByText("About oscilla naga");
    expect(sidebar.contains(resultNode)).toBe(false);

    cleanup();
  });

  it("clearing the search (Esc) resets state and returns to tree mode", async () => {
    useSessionStore.setState({
      searchQuery: "foo",
      searchResults: [makeSearchResult()],
      searchStatus: "done",
    });

    render(<SessionEditor />);
    const input = screen.getByLabelText("Search session content");
    // fireEvent bypasses userEvent's internal timing; we just want to assert
    // the Esc handler wired to the input triggers clearSearch.
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      const state = useSessionStore.getState();
      expect(state.searchResults).toBeNull();
      expect(state.searchQuery).toBe("");
    });

    cleanup();
  });

  it("clicking a result opens peek (non-destructive) — search stays intact", async () => {
    const result = makeSearchResult();
    let peekedFilePath: string | null = null;
    const peekedMessages: MessageSummary[] = [makeMessage(0), makeMessage(1)];
    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:peek": (...args) => {
        peekedFilePath = args[1] as string;
        return peekedMessages;
      },
    });

    useSessionStore.setState({
      searchQuery: "oscilla",
      searchResults: [result],
      searchStatus: "done",
      providerMetadata: {
        claude: {
          badge: { label: "Claude", color: "" },
          typeStyles: { user: { label: "User", color: "" } },
          flagDefinitions: {},
          helpText: {
            description: "",
            resumeCommand: "",
            safeToRemove: [],
            beCareful: [],
          },
        },
      },
    });

    render(<SessionEditor />);

    // Clicking the card's header opens peek.
    fireEvent.click(screen.getByText("About oscilla naga"));

    await waitFor(() => {
      expect(peekedFilePath).toBe(result.filePath);
      const state = useSessionStore.getState();
      // Search state survives — user can still see the results list.
      expect(state.searchResults).not.toBeNull();
      expect(state.peekResult?.filePath).toBe(result.filePath);
      expect(state.peekMessages).toEqual(peekedMessages);
    });

    cleanup();
  });

  it("clicking 'Open in Editor' loads the session and discards search + peek", async () => {
    const result = makeSearchResult();
    let loadedFilePath: string | null = null;
    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "session:peek": () => [makeMessage(0)],
      "session:load": (...args) => {
        loadedFilePath = args[1] as string;
        return [];
      },
      "session:list-versions": () => ({
        sessionPath: "",
        provider: "claude",
        head: 0,
        versions: [],
      }),
    });

    useSessionStore.setState({
      searchQuery: "oscilla",
      searchResults: [result],
      searchStatus: "done",
      providerMetadata: {
        claude: {
          badge: { label: "Claude", color: "" },
          typeStyles: { user: { label: "User", color: "" } },
          flagDefinitions: {},
          helpText: {
            description: "",
            resumeCommand: "",
            safeToRemove: [],
            beCareful: [],
          },
        },
      },
    });

    render(<SessionEditor />);

    // The "Open in Editor" button appears on every result card (there are
    // possibly multiple — one inside each card, and after peek opens, one
    // more inside the peek header). Pick the first (on the card).
    const openButtons = screen.getAllByText("Open in Editor");
    expect(openButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(openButtons[0]);

    await waitFor(() => {
      expect(loadedFilePath).toBe(result.filePath);
      const state = useSessionStore.getState();
      expect(state.searchResults).toBeNull();
      expect(state.peekResult).toBeNull();
    });

    cleanup();
  });
});

describe("Topic Focus — segment-only vs focus-and-mark", () => {
  // Shared settings mock so the component's settings:load effect doesn't
  // throw on an undefined response.
  const defaultSettings = () => ({
    openaiApiKey: "",
    openaiModel: "gpt-5.4",
    lastRoute: "/workshop",
    compressSummarizeThreshold: 5000,
    compressTruncateThreshold: 1000,
    compressKeepLastN: 3,
  });

  it("clicking Topic Focus runs segmentation with an empty focus query and renders segment chips without marking anything", async () => {
    setStoreLoaded({
      messages: [makeMessage(0), makeMessage(1), makeMessage(2)],
    });
    const segmentCalls: unknown[][] = [];

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": defaultSettings,
      "llm:segment-topics": (...args) => {
        segmentCalls.push(args);
        return [
          {
            topic: "initial setup",
            startIndex: 0,
            endIndex: 1,
            tokenCount: 200,
            relevant: true,
          },
          {
            topic: "bug fix",
            startIndex: 2,
            endIndex: 2,
            tokenCount: 100,
            relevant: true,
          },
        ];
      },
    });

    const user = setupUser();
    render(<SessionEditor />);
    await user.click(screen.getByRole("button", { name: "Topic Focus" }));

    // Segments panel shows the chips
    await screen.findByText(/initial setup/);
    expect(screen.getByText(/bug fix/)).toBeTruthy();

    // Legend is visible so the kept/removed distinction is explicit
    expect(screen.getByText(/stays in the session/)).toBeTruthy();
    expect(screen.getByText(/will be deleted on Save/)).toBeTruthy();

    // The segmentation IPC was invoked with an empty focus query — this is
    // what makes the button a "segment only" action.
    expect(segmentCalls.length).toBe(1);
    expect(segmentCalls[0][2]).toBe("");

    // Segment-only mode does NOT auto-mark any message for removal.
    expect(useSessionStore.getState().markedForRemoval.size).toBe(0);

    cleanup();
  });

  it("submitting a focus query runs segmentation with the query and auto-marks off-topic messages", async () => {
    setStoreLoaded({
      messages: [makeMessage(0), makeMessage(1), makeMessage(2)],
    });
    const segmentCalls: unknown[][] = [];

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": defaultSettings,
      "llm:segment-topics": (...args) => {
        segmentCalls.push(args);
        const query = args[2] as string;
        const relevantFor = (topic: string) => {
          if (query === "") return true;
          return topic.toLowerCase().includes(query.toLowerCase());
        };
        return [
          {
            topic: "unrelated work",
            startIndex: 0,
            endIndex: 0,
            tokenCount: 50,
            relevant: relevantFor("unrelated work"),
          },
          {
            topic: "auth refactor",
            startIndex: 1,
            endIndex: 2,
            tokenCount: 200,
            relevant: relevantFor("auth refactor"),
          },
        ];
      },
    });

    const user = setupUser();
    render(<SessionEditor />);

    // First: open the segments panel via the button (segment-only)
    await user.click(screen.getByRole("button", { name: "Topic Focus" }));
    await screen.findByText(/unrelated work/);

    // Then type a focus query into the panel's input and submit it
    const input = screen.getByPlaceholderText(/authentication implementation/);
    fireEvent.change(input, { target: { value: "auth" } });
    await user.click(screen.getByRole("button", { name: /Mark off-topic/ }));

    // Off-topic segment (message index 0) is marked for removal
    await waitFor(() => {
      const marked = useSessionStore.getState().markedForRemoval;
      expect(marked.has(0)).toBe(true);
      expect(marked.has(1)).toBe(false);
      expect(marked.has(2)).toBe(false);
    });

    // Two IPC calls: one with empty query (segment-only), one with "auth"
    expect(segmentCalls.length).toBe(2);
    expect(segmentCalls[0][2]).toBe("");
    expect(segmentCalls[1][2]).toBe("auth");

    cleanup();
  });

  it("switching sessions clears Topic Focus state (query + segments)", async () => {
    setStoreLoaded({ messages: [makeMessage(0)] });

    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": defaultSettings,
      "llm:segment-topics": () => [
        {
          topic: "session A topic",
          startIndex: 0,
          endIndex: 0,
          tokenCount: 100,
          relevant: true,
        },
      ],
    });

    const user = setupUser();
    render(<SessionEditor />);

    // Segment session A and type a focus query
    await user.click(screen.getByRole("button", { name: "Topic Focus" }));
    await screen.findByText(/session A topic/);
    const input = screen.getByPlaceholderText(/authentication implementation/);
    fireEvent.change(input, { target: { value: "leftover query" } });
    expect((input as HTMLInputElement).value).toBe("leftover query");

    // Switch to a different session — state keyed by sessionId should reset
    useSessionStore.setState({
      selectedSession: {
        ...makeSession(),
        sessionId: "session-B",
        filePath: "/test/session-B.jsonl",
      },
      messages: [makeMessage(0), makeMessage(1)],
      markedForRemoval: new Set(),
    });

    await waitFor(() => {
      // Segments panel is gone — segment list was cleared
      expect(screen.queryByText(/session A topic/)).toBeNull();
      // The stale focus query input from session A should not appear at all
      expect(
        screen.queryByPlaceholderText(/authentication implementation/),
      ).toBeNull();
    });

    // Re-open on session B: the query field should come back empty, not with "leftover query"
    setInvokeHandlers(api, {
      "session:list-projects": () => [],
      "session:provider-metadata": () => ({}),
      "settings:load": defaultSettings,
      "llm:segment-topics": () => [
        {
          topic: "session B topic",
          startIndex: 0,
          endIndex: 1,
          tokenCount: 150,
          relevant: true,
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Topic Focus" }));
    await screen.findByText(/session B topic/);
    const freshInput = screen.getByPlaceholderText(
      /authentication implementation/,
    );
    expect((freshInput as HTMLInputElement).value).toBe("");

    cleanup();
  });
});

describe("Toolbar restructure — Save button always visible", () => {
  it("renders the Save button in a row separate from the tool buttons (so it is not pushed off-screen on narrow widths)", async () => {
    setStoreLoaded({ messages: [makeMessage(0), makeMessage(1)] });
    useSessionStore.setState({ markedForRemoval: new Set([0]) });

    render(<SessionEditor />);

    const saveBtn = screen.getByRole("button", { name: /Remove .* & Save/i });
    const autoTrimBtn = screen.getByRole("button", { name: "Auto-Trim" });

    // Walk up each element's ancestors collecting their parents; the two
    // buttons must NOT share the nearest flex-row container. The save row
    // is intentionally its own flex line so it can never be pushed off.
    function nearestFlexRow(el: HTMLElement): HTMLElement | null {
      let cur: HTMLElement | null = el.parentElement;
      while (cur) {
        if (
          cur.className.includes("flex") &&
          !cur.className.includes("flex-col")
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }
    const saveRow = nearestFlexRow(saveBtn);
    const toolRow = nearestFlexRow(autoTrimBtn);
    expect(saveRow).not.toBeNull();
    expect(toolRow).not.toBeNull();
    expect(saveRow).not.toBe(toolRow);

    cleanup();
  });
});
