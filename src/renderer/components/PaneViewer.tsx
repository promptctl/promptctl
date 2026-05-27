import { useEffect, useState } from "react";
import { PaneTerminal } from "@promptctl/pane-terminal/react";
import "@xterm/xterm/css/xterm.css";
import { usePaneSelectionStore } from "../store/pane-selection";
import { useLaunchStore } from "../store/launches";
import { useTopology, usePaneStream } from "../tmux/proxy";
import { usePaneKeymapMode } from "../lib/use-pane-keymap";
import type { ToolKind, PaneProcesses, PaneId } from "../../shared/types";

const TOOL_COLORS: Record<ToolKind, string> = {
  claude: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  codex: "bg-green-500/10 text-green-400 border-green-500/20",
  gemini: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  unknown: "",
};

function ProcessInfoPanel({ paneId }: { paneId: PaneId }) {
  const [processes, setProcesses] = useState<PaneProcesses | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;

    const fetch = async () => {
      const result = (await window.electronAPI.invoke(
        "tmux:pane-processes",
        paneId,
      )) as PaneProcesses;
      if (active) setProcesses(result);
    };

    fetch();
    const interval = setInterval(fetch, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [paneId]);

  const childCount = processes?.children.length ?? 0;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300"
      >
        <span className="text-[9px]">{expanded ? "▼" : "▶"}</span>
        {childCount} child process{childCount !== 1 ? "es" : ""}
      </button>
      {expanded && processes && processes.children.length > 0 && (
        <div className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-900/50">
          <table className="w-full text-[11px] text-neutral-400">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-neutral-500">
                <th className="px-2 py-1">PID</th>
                <th className="px-2 py-1">Command</th>
                <th className="px-2 py-1">Elapsed</th>
                <th className="px-2 py-1">CPU</th>
                <th className="px-2 py-1">Args</th>
              </tr>
            </thead>
            <tbody>
              {processes.children.map((p) => (
                <tr key={p.pid} className="border-b border-neutral-800/50">
                  <td className="px-2 py-1 font-mono">{p.pid}</td>
                  <td className="px-2 py-1">{p.comm}</td>
                  <td className="px-2 py-1 font-mono">{p.elapsed}</td>
                  <td className="px-2 py-1 font-mono">{p.cpuTime}</td>
                  <td className="max-w-xs truncate px-2 py-1 font-mono">
                    {p.args}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PaneViewer() {
  const selectedPaneId = usePaneSelectionStore((s) => s.selectedPaneId);
  const topology = useTopology();
  const pane = topology.panes.find((p) => p.id === selectedPaneId);
  // [LAW:one-source-of-truth] The launch row is looked up by paneId from
  // the registry-backed store. The badge is presence-driven — non-null
  // means promptctl spawned this pane and the launch is still alive.
  //
  // Subscribe to the *result* (not the lookup function), so Zustand
  // re-renders this component when the underlying `launches` array
  // changes. Selecting `s.byPane` alone would memoize a stable
  // function reference and miss every registry update.
  const launch = useLaunchStore((s) =>
    pane
      ? s.launches.find((l) => l.paneId === pane.id && l.status !== "exited")
      : undefined,
  );
  // [LAW:dataflow-not-control-flow] Stream is keyed on the *valid* pane — if
  // selection points to a gone pane, we drop to null and the terminal unmounts.
  // The selection store is untouched (user keeps their intent); when the pane
  // comes back or another is picked the stream rebuilds.
  const stream = usePaneStream(pane ?? null);
  const keymapMode = usePaneKeymapMode();

  if (!selectedPaneId || !pane) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        Select a pane from the sidebar
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-neutral-100">
            {pane.sessionName} → {pane.windowName}:{pane.paneIndex}
          </h2>
          {pane.toolKind !== "unknown" && (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TOOL_COLORS[pane.toolKind]}`}
            >
              {pane.toolKind}
            </span>
          )}
          {launch && (
            <span
              data-testid="loops-launch-badge"
              title={`launchId: ${launch.launchId}`}
              className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] text-violet-300"
            >
              ↳ launch {launch.launchId.slice(0, 8)}
            </span>
          )}
          {keymapMode === "prefix" && (
            <span
              data-testid="loops-keymap-prefix-indicator"
              title="tmux prefix active — next key is interpreted as a prefix binding"
              className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300"
            >
              ⌃B
            </span>
          )}
          <span className="ml-auto text-xs text-neutral-500">
            {pane.currentCommand} · {pane.currentPath} · {pane.width}×
            {pane.height} · PID {pane.pid}
          </span>
        </div>
        <ProcessInfoPanel paneId={selectedPaneId} />
      </div>

      <div
        data-testid="loops-pane-terminal"
        data-pane-id={pane.id}
        className="min-h-0 flex-1 overflow-hidden rounded-lg bg-neutral-900"
      >
        {stream !== null && (
          <PaneTerminal stream={stream} className="h-full w-full" autoFocus />
        )}
      </div>
    </div>
  );
}
