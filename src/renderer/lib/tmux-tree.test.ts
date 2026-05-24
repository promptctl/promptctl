import { describe, it, expect } from "vitest";
import { buildTree, filterPanes, flatLabel } from "./tmux-tree";
import type { TmuxPane, PaneId, SessionId, WindowId } from "../../shared/types";

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: "%0" as PaneId,
    sessionName: "test",
    sessionId: "$0" as SessionId,
    windowName: "main",
    windowId: "@0" as WindowId,
    windowIndex: 0,
    paneIndex: 0,
    pid: 1000,
    currentCommand: "bash",
    currentPath: "/tmp",
    width: 80,
    height: 24,
    active: true,
    toolKind: "unknown",
    ...overrides,
  };
}

describe("filterPanes", () => {
  it("returns all panes for empty query", () => {
    const panes = [makePane(), makePane({ id: "%1" as PaneId })];
    expect(filterPanes(panes, "")).toHaveLength(2);
  });

  it("filters by session name", () => {
    const panes = [
      makePane({ sessionName: "work" }),
      makePane({ id: "%1" as PaneId, sessionName: "play" }),
    ];
    expect(filterPanes(panes, "work")).toHaveLength(1);
  });

  it("filters by current command", () => {
    const panes = [
      makePane({ currentCommand: "claude" }),
      makePane({ id: "%1" as PaneId, currentCommand: "bash" }),
    ];
    expect(filterPanes(panes, "claude")).toHaveLength(1);
  });

  it("filters by current path", () => {
    const panes = [
      makePane({ currentPath: "/home/user/project" }),
      makePane({ id: "%1" as PaneId, currentPath: "/tmp" }),
    ];
    expect(filterPanes(panes, "project")).toHaveLength(1);
  });

  it("is case insensitive", () => {
    const panes = [makePane({ sessionName: "MySession" })];
    expect(filterPanes(panes, "mysession")).toHaveLength(1);
  });

  it("filters by pane ID", () => {
    const panes = [
      makePane({ id: "%42" as PaneId }),
      makePane({ id: "%1" as PaneId }),
    ];
    expect(filterPanes(panes, "%42")).toHaveLength(1);
  });
});

describe("flatLabel", () => {
  it("omits pane index when single pane in window", () => {
    const pane = makePane({
      sessionName: "dev",
      windowIndex: 0,
      windowName: "code",
    });
    expect(flatLabel(pane, 1)).toBe("dev > 0:code");
  });

  it("includes pane index when multiple panes", () => {
    const pane = makePane({
      sessionName: "dev",
      windowIndex: 0,
      windowName: "code",
      paneIndex: 1,
    });
    expect(flatLabel(pane, 2)).toBe("dev > 0:code > pane 1");
  });
});

describe("buildTree", () => {
  it("returns empty array for no panes", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("groups panes by session and window", () => {
    const panes = [
      makePane({
        id: "%0" as PaneId,
        sessionName: "s1",
        sessionId: "$0" as SessionId,
        windowName: "w1",
        windowId: "@0" as WindowId,
      }),
      makePane({
        id: "%1" as PaneId,
        sessionName: "s1",
        sessionId: "$0" as SessionId,
        windowName: "w1",
        windowId: "@0" as WindowId,
        paneIndex: 1,
      }),
      makePane({
        id: "%2" as PaneId,
        sessionName: "s1",
        sessionId: "$0" as SessionId,
        windowName: "w2",
        windowId: "@1" as WindowId,
        windowIndex: 1,
      }),
    ];

    const tree = buildTree(panes);
    expect(tree).toHaveLength(1);
    expect(tree[0].windows).toHaveLength(2);
    expect(tree[0].windows[0].panes).toHaveLength(2);
    expect(tree[0].windows[1].panes).toHaveLength(1);
  });

  it("sorts sessions by name", () => {
    const panes = [
      makePane({ sessionName: "zebra", sessionId: "$1" as SessionId }),
      makePane({
        id: "%1" as PaneId,
        sessionName: "alpha",
        sessionId: "$0" as SessionId,
      }),
    ];

    const tree = buildTree(panes);
    expect(tree[0].name).toBe("alpha");
    expect(tree[1].name).toBe("zebra");
  });

  it("sorts windows by index", () => {
    const panes = [
      makePane({
        windowName: "second",
        windowId: "@1" as WindowId,
        windowIndex: 2,
      }),
      makePane({
        id: "%1" as PaneId,
        windowName: "first",
        windowId: "@0" as WindowId,
        windowIndex: 0,
      }),
    ];

    const tree = buildTree(panes);
    expect(tree[0].windows[0].name).toBe("first");
    expect(tree[0].windows[1].name).toBe("second");
  });
});
