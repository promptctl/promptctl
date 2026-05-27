import { useEffect, useState } from "react";
import type { PaneProcesses, TmuxPane } from "../../shared/types";

// [LAW:dataflow-not-control-flow] The process tree is a derived value of
// (paneId, foreground command, pane pid). A wall-clock setInterval mixed
// control flow ("if 5s elapsed, refetch") into a problem that's pure data:
// when the topology broadcast updates currentCommand or pid, the tree may
// have changed; otherwise it hasn't. The refresh button bumps a tick for
// the rare case where the foreground command stayed the same but a
// grandchild churned.
export function ProcessInfoPanel({ pane }: { pane: TmuxPane }) {
  const [processes, setProcesses] = useState<PaneProcesses | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let active = true;
    // [LAW:no-defensive-null-guards] Not a guard — log so a failing IPC
    // surface is visible in the dev console rather than swallowed. The
    // panel keeps showing the last good snapshot until the next refetch
    // succeeds, which is a sensible fallback at this trust boundary.
    void window.electronAPI
      .invoke("tmux:pane-processes", pane.id)
      .then((result) => {
        if (active) setProcesses(result as PaneProcesses);
      })
      .catch((err: unknown) => {
        if (active) console.error("tmux:pane-processes failed", err);
      });
    return () => {
      active = false;
    };
  }, [pane.id, pane.currentCommand, pane.pid, refreshTick]);

  const childCount = processes?.children.length ?? 0;

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          data-testid="loops-process-info-toggle"
          className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300"
        >
          <span className="text-[9px]">{expanded ? "▼" : "▶"}</span>
          {childCount} child process{childCount !== 1 ? "es" : ""}
        </button>
        {expanded && (
          <button
            onClick={() => setRefreshTick((n) => n + 1)}
            data-testid="loops-process-info-refresh"
            aria-label="Refresh process tree"
            title="Refresh process tree"
            className="text-[10px] text-neutral-600 hover:text-neutral-300"
          >
            ↻
          </button>
        )}
      </div>
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
