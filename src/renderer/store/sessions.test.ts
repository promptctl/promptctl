import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "./sessions";
import {
  installElectronMock,
  setInvokeHandlers,
  type MockElectronAPI,
} from "../../test/electron-mock";
import type {
  MessageSummary,
  VersionMeta,
  DiffEntry,
  Project,
  SessionInfo,
} from "../../shared/types";

let api: MockElectronAPI;

function resetStore() {
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
  });
}

function makeMessage(
  index: number,
  type = "user",
  preview = "",
): MessageSummary {
  return {
    index,
    id: `msg-${index}`,
    type,
    timestamp: "",
    tokens: 100,
    preview: preview || `message ${index}`,
    hasToolCalls: false,
    hasToolResults: false,
    toolNames: [],
    flags: [],
    extras: {},
  };
}

function makeVersionMeta(head = 1, count = 1): VersionMeta {
  return {
    sessionPath: "/test/session.jsonl",
    provider: "claude",
    head,
    versions: Array.from({ length: count }, (_, i) => ({
      idx: i + 1,
      ts: "2025-01-01T00:00:00Z",
      label: `v${i + 1}`,
      sizeBytes: 100,
      tokensTotal: 50,
    })),
  };
}

beforeEach(() => {
  api = installElectronMock();
  resetStore();
});

// ============================================================
// loadVersions
// ============================================================

describe("loadVersions", () => {
  it("populates versions and versionHead from IPC response", async () => {
    setInvokeHandlers(api, {
      "session:list-versions": () => makeVersionMeta(2, 3),
    });

    await useSessionStore.getState().loadVersions();

    const state = useSessionStore.getState();
    expect(state.versions).toHaveLength(3);
    expect(state.versionHead).toBe(2);
  });
});

// ============================================================
// undo
// ============================================================

describe("undo", () => {
  it("invokes IPC and reloads messages on success", async () => {
    const newMessages = [makeMessage(0)];
    setInvokeHandlers(api, {
      "session:undo": () => newMessages,
      "session:list-versions": () => makeVersionMeta(1, 2),
    });

    await useSessionStore.getState().undo();

    const state = useSessionStore.getState();
    expect(state.messages).toEqual(newMessages);
    expect(state.versionHead).toBe(1);
  });

  it("does nothing when undo returns null (already at head=1)", async () => {
    const initialMessages = [makeMessage(0), makeMessage(1)];
    useSessionStore.setState({ messages: initialMessages });

    setInvokeHandlers(api, {
      "session:undo": () => null,
    });

    await useSessionStore.getState().undo();

    expect(useSessionStore.getState().messages).toEqual(initialMessages);
  });

  it("clears markedForRemoval after undo", async () => {
    useSessionStore.setState({ markedForRemoval: new Set([0, 1]) });

    setInvokeHandlers(api, {
      "session:undo": () => [makeMessage(0)],
      "session:list-versions": () => makeVersionMeta(1, 1),
    });

    await useSessionStore.getState().undo();

    expect(useSessionStore.getState().markedForRemoval.size).toBe(0);
  });
});

// ============================================================
// redo
// ============================================================

describe("redo", () => {
  it("invokes IPC and reloads messages on success", async () => {
    const newMessages = [makeMessage(0), makeMessage(1)];
    setInvokeHandlers(api, {
      "session:redo": () => newMessages,
      "session:list-versions": () => makeVersionMeta(2, 2),
    });

    await useSessionStore.getState().redo();

    const state = useSessionStore.getState();
    expect(state.messages).toEqual(newMessages);
    expect(state.versionHead).toBe(2);
  });

  it("does nothing when redo returns null (at tip)", async () => {
    const initialMessages = [makeMessage(0)];
    useSessionStore.setState({ messages: initialMessages });

    setInvokeHandlers(api, {
      "session:redo": () => null,
    });

    await useSessionStore.getState().redo();

    expect(useSessionStore.getState().messages).toEqual(initialMessages);
  });
});

// ============================================================
// restoreVersion
// ============================================================

describe("restoreVersion", () => {
  it("invokes IPC, reloads messages, and refreshes versions", async () => {
    const restoredMessages = [makeMessage(0), makeMessage(1), makeMessage(2)];
    setInvokeHandlers(api, {
      "session:restore-version": () => restoredMessages,
      "session:list-versions": () => makeVersionMeta(4, 4),
    });

    await useSessionStore.getState().restoreVersion(1);

    const state = useSessionStore.getState();
    expect(state.messages).toEqual(restoredMessages);
    expect(state.versions).toHaveLength(4);
    expect(state.versionHead).toBe(4);
  });

  it("clears markedForRemoval after restore", async () => {
    useSessionStore.setState({ markedForRemoval: new Set([0, 1]) });
    setInvokeHandlers(api, {
      "session:restore-version": () => [makeMessage(0)],
      "session:list-versions": () => makeVersionMeta(1, 1),
    });

    await useSessionStore.getState().restoreVersion(1);

    expect(useSessionStore.getState().markedForRemoval.size).toBe(0);
  });

  it("does nothing when restore returns null", async () => {
    const initialMessages = [makeMessage(0)];
    useSessionStore.setState({ messages: initialMessages });

    setInvokeHandlers(api, {
      "session:restore-version": () => null,
    });

    await useSessionStore.getState().restoreVersion(99);

    expect(useSessionStore.getState().messages).toEqual(initialMessages);
  });
});

// ============================================================
// diffVersions
// ============================================================

describe("diffVersions", () => {
  it("returns DiffEntry[] from IPC", async () => {
    const diff: DiffEntry[] = [
      { kind: "unchanged", count: 5 },
      { kind: "removed", messages: [makeMessage(0)] },
    ];
    setInvokeHandlers(api, {
      "session:diff-versions": () => diff,
    });

    const result = await useSessionStore.getState().diffVersions(1, 2);
    expect(result).toEqual(diff);
  });
});

// ============================================================
// save reloads versions
// ============================================================

describe("save action", () => {
  it("reloads versions after successful save", async () => {
    useSessionStore.setState({
      selectedSession: {
        sessionId: "test",
        filePath: "/test.jsonl",
        summary: "",
        startTime: "",
        lastUpdated: "",
        messageCount: 0,
        fileSizeBytes: 0,
        previewMessages: [],
      },
      selectedProvider: "claude",
      markedForRemoval: new Set([0]),
    });

    setInvokeHandlers(api, {
      "session:save": () => ({
        path: "/test.jsonl",
        violations: [],
        forced: false,
        blockedReason: null,
      }),
      "session:load": () => [makeMessage(0)],
      "session:list-versions": () => makeVersionMeta(2, 2),
    });

    await useSessionStore.getState().save();

    const state = useSessionStore.getState();
    expect(state.versions).toHaveLength(2);
    expect(state.versionHead).toBe(2);
    expect(state.markedForRemoval.size).toBe(0);
  });
});

// ============================================================
// selectSessionById (deep-link entry path)
// ============================================================

describe("selectSessionById", () => {
  const project: Project = {
    name: "promptctl",
    paths: ["/tmp/project-dir"],
    projectRoot: "/Users/bmf/code/promptctl",
    provider: "claude",
  };
  const session: SessionInfo = {
    sessionId: "abc-123",
    filePath: "/tmp/project-dir/abc-123.jsonl",
    summary: "hello",
    startTime: "2026-04-18T10:00:00Z",
    lastUpdated: "2026-04-18T10:00:01Z",
    messageCount: 2,
    fileSizeBytes: 100,
    previewMessages: [],
  };

  it("resolves and selects when the session exists", async () => {
    setInvokeHandlers(api, {
      "session:find": () => ({ project, session }),
      "session:load": () => [makeMessage(0)],
      "session:list-versions": () => makeVersionMeta(1, 1),
      // selectSession kicks off runAllAnalyzers (slice 1 unified pipeline);
      // returning [] keeps the test focused on the deep-link path without
      // exercising analyzer behavior here.
      "session:list-analyzers": () => [],
    });

    const ok = await useSessionStore
      .getState()
      .selectSessionById("claude", "abc-123");

    expect(ok).toBe(true);
    const state = useSessionStore.getState();
    expect(state.selectedSession?.sessionId).toBe("abc-123");
    expect(state.selectedProvider).toBe("claude");
    expect(state.selectedProjectPath).toBe("/Users/bmf/code/promptctl");
    expect(state.expandedProjects.has("/Users/bmf/code/promptctl")).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it("returns false and does not mutate when the session is missing", async () => {
    setInvokeHandlers(api, {
      "session:find": () => null,
    });

    const ok = await useSessionStore
      .getState()
      .selectSessionById("claude", "missing");

    expect(ok).toBe(false);
    expect(useSessionStore.getState().selectedSession).toBeNull();
  });

  it("short-circuits when the session is already selected", async () => {
    useSessionStore.setState({ selectedSession: session });
    setInvokeHandlers(api, {
      "session:find": () => {
        throw new Error("should not be called");
      },
    });

    const ok = await useSessionStore
      .getState()
      .selectSessionById("claude", "abc-123");

    expect(ok).toBe(true);
    // session:find was never invoked
    expect(api.invoke.mock.calls.some((c) => c[0] === "session:find")).toBe(
      false,
    );
  });
});
