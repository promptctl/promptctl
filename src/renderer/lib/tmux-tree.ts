import type {
  TmuxPane,
  TmuxSession,
  TmuxWindow,
  SessionId,
} from "../../shared/types";

// [LAW:dataflow-not-control-flow] Empty query matches everything.
export function filterPanes(panes: TmuxPane[], query: string): TmuxPane[] {
  const lower = query.toLowerCase();
  return panes.filter((p) =>
    [p.sessionName, p.windowName, p.currentCommand, p.currentPath, p.id].some(
      (field) => field.toLowerCase().includes(lower),
    ),
  );
}

// Format a pane as a flat label: "session > window:index" (omit pane if only one)
export function flatLabel(pane: TmuxPane, paneCountInWindow: number): string {
  const base = `${pane.sessionName} > ${pane.windowIndex}:${pane.windowName}`;
  return paneCountInWindow > 1 ? `${base} > pane ${pane.paneIndex}` : base;
}

// [LAW:dataflow-not-control-flow] Always runs, returns empty array for empty input.
// Pure derivation from flat pane list to tree structure.
export function buildTree(panes: TmuxPane[]): TmuxSession[] {
  const sessionMap = new Map<
    string,
    { name: string; id: SessionId; windowMap: Map<string, TmuxWindow> }
  >();

  for (const pane of panes) {
    let session = sessionMap.get(pane.sessionId);
    if (!session) {
      session = {
        name: pane.sessionName,
        id: pane.sessionId,
        windowMap: new Map(),
      };
      sessionMap.set(pane.sessionId, session);
    }

    let window = session.windowMap.get(pane.windowId);
    if (!window) {
      window = {
        name: pane.windowName,
        id: pane.windowId,
        index: pane.windowIndex,
        panes: [],
      };
      session.windowMap.set(pane.windowId, window);
    }

    window.panes.push(pane);
  }

  return Array.from(sessionMap.values())
    .map((s) => ({
      name: s.name,
      id: s.id,
      windows: Array.from(s.windowMap.values()).sort(
        (a, b) => a.index - b.index,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
