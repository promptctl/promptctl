import { useState, type MouseEvent } from "react";
import { useTmuxStore } from "../store/tmux";
import { buildTree, filterPanes, flatLabel } from "../lib/tmux-tree";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { PaneId, TmuxPane, ToolKind } from "../../shared/types";

const TOOL_LABELS: Record<ToolKind, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  unknown: "",
};

const TOOL_COLORS: Record<ToolKind, string> = {
  claude: "text-orange-400",
  codex: "text-green-400",
  gemini: "text-blue-400",
  unknown: "text-neutral-500",
};

function PaneRow({
  pane,
  selected,
  onSelect,
  label,
  onContextMenu,
}: {
  pane: TmuxPane;
  selected: boolean;
  onSelect: (id: PaneId) => void;
  label?: string;
  onContextMenu: (e: MouseEvent, items: ContextMenuItem[]) => void;
}) {
  const toolLabel = TOOL_LABELS[pane.toolKind];

  const handleContext = (e: MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, [
      {
        label: `Copy pane ID (${pane.id})`,
        action: () => navigator.clipboard.writeText(pane.id),
      },
    ]);
  };

  return (
    <button
      onClick={() => onSelect(pane.id)}
      onContextMenu={handleContext}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
        selected
          ? "bg-neutral-700 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      }`}
    >
      <span className={`shrink-0 ${TOOL_COLORS[pane.toolKind]}`}>
        {pane.active ? "●" : "○"}
      </span>
      <span className="min-w-0 truncate">
        {label ?? pane.currentCommand}
        {!label && pane.currentPath
          ? ` — ${pane.currentPath.split("/").pop()}`
          : ""}
      </span>
      {toolLabel && (
        <span
          className={`ml-auto shrink-0 text-[10px] font-medium ${TOOL_COLORS[pane.toolKind]}`}
        >
          {toolLabel}
        </span>
      )}
    </button>
  );
}

function SessionNode({
  name,
  sessionId,
  children,
  onContextMenu,
}: {
  name: string;
  sessionId: string;
  children: React.ReactNode;
  onContextMenu: (e: MouseEvent, items: ContextMenuItem[]) => void;
}) {
  const [open, setOpen] = useState(true);

  const handleContext = (e: MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, [
      {
        label: `Copy session ID (${sessionId})`,
        action: () => navigator.clipboard.writeText(sessionId),
      },
      {
        label: `Copy session name (${name})`,
        action: () => navigator.clipboard.writeText(name),
      },
    ]);
  };

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        onContextMenu={handleContext}
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-neutral-300 hover:bg-neutral-800"
      >
        <span className="text-[10px]">{open ? "▼" : "▶"}</span>
        {name}
      </button>
      {open && <div className="ml-2">{children}</div>}
    </div>
  );
}

function WindowNode({
  name,
  index,
  windowId,
  children,
  onContextMenu,
}: {
  name: string;
  index: number;
  windowId: string;
  children: React.ReactNode;
  onContextMenu: (e: MouseEvent, items: ContextMenuItem[]) => void;
}) {
  const [open, setOpen] = useState(true);

  const handleContext = (e: MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, [
      {
        label: `Copy window ID (${windowId})`,
        action: () => navigator.clipboard.writeText(windowId),
      },
    ]);
  };

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        onContextMenu={handleContext}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800"
      >
        <span className="text-[9px]">{open ? "▼" : "▶"}</span>
        {index}:{name}
      </button>
      {open && <div className="ml-2">{children}</div>}
    </div>
  );
}

export function TmuxTree() {
  const snapshot = useTmuxStore((s) => s.snapshot);
  const selectedPaneId = useTmuxStore((s) => s.selectedPaneId);
  const selectPane = useTmuxStore((s) => s.selectPane);
  const filterText = useTmuxStore((s) => s.filterText);
  const setFilterText = useTmuxStore((s) => s.setFilterText);
  const viewMode = useTmuxStore((s) => s.viewMode);
  const setViewMode = useTmuxStore((s) => s.setViewMode);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  const filtered = filterPanes(snapshot.panes, filterText);
  const tree = buildTree(filtered);

  // Count panes per window for flat label
  const windowPaneCounts = new Map<string, number>();
  for (const pane of filtered) {
    windowPaneCounts.set(
      pane.windowId,
      (windowPaneCounts.get(pane.windowId) ?? 0) + 1,
    );
  }

  const handleContextMenu = (e: MouseEvent, items: ContextMenuItem[]) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Search + view toggle */}
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter..."
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
        />
        <button
          onClick={() => setViewMode(viewMode === "tree" ? "flat" : "tree")}
          className="shrink-0 rounded px-1.5 py-1 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          title={viewMode === "tree" ? "Switch to flat view" : "Switch to tree view"}
        >
          {viewMode === "tree" ? "≡" : "▤"}
        </button>
      </div>

      {/* Pane list */}
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="px-2 py-4 text-xs text-neutral-500">
            {filterText ? "No matches" : "No tmux sessions found"}
          </p>
        )}

        {viewMode === "flat" &&
          filtered
            .sort((a, b) =>
              `${a.sessionName}:${a.windowIndex}:${a.paneIndex}`.localeCompare(
                `${b.sessionName}:${b.windowIndex}:${b.paneIndex}`,
              ),
            )
            .map((pane) => (
              <PaneRow
                key={pane.id}
                pane={pane}
                selected={pane.id === selectedPaneId}
                onSelect={selectPane}
                label={flatLabel(
                  pane,
                  windowPaneCounts.get(pane.windowId) ?? 1,
                )}
                onContextMenu={handleContextMenu}
              />
            ))}

        {viewMode === "tree" &&
          tree.map((session) => (
            <SessionNode
              key={session.id}
              name={session.name}
              sessionId={session.id}
              onContextMenu={handleContextMenu}
            >
              {session.windows.map((window) => (
                <WindowNode
                  key={window.id}
                  name={window.name}
                  index={window.index}
                  windowId={window.id}
                  onContextMenu={handleContextMenu}
                >
                  {window.panes.map((pane) => (
                    <PaneRow
                      key={pane.id}
                      pane={pane}
                      selected={pane.id === selectedPaneId}
                      onSelect={selectPane}
                      onContextMenu={handleContextMenu}
                    />
                  ))}
                </WindowNode>
              ))}
            </SessionNode>
          ))}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
