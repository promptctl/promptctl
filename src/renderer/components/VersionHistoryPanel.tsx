import type { VersionInfo } from "../../shared/types";

function formatTimestamp(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface VersionHistoryPanelProps {
  versions: VersionInfo[];
  head: number;
  onClose: () => void;
  onViewDiff: (fromIdx: number, toIdx: number) => void;
  onRestore: (idx: number) => void;
  // Set when the active file is being appended to by a live launch.
  // Restore writes the file in place, so it would clobber the live
  // launch's in-flight output — disable the affordance to make the
  // block visible. The coordinator-level guard (LiveTailBlockedError
  // in editor.ts) is defense-in-depth for direct-IPC callers.
  restoreBlockedReason?: string | null;
}

export function VersionHistoryPanel({
  versions,
  head,
  onClose,
  onViewDiff,
  onRestore,
  restoreBlockedReason = null,
}: VersionHistoryPanelProps) {
  // Newest first
  const ordered = [...versions].sort((a, b) => b.idx - a.idx);

  return (
    <div
      data-testid="version-history-panel"
      className="flex h-full w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h3 className="text-base font-medium text-neutral-200">
          Version History
        </h3>
        <button
          data-testid="version-history-close"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      {ordered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-neutral-500">
          No versions yet. Edits to this conversation will appear here.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {ordered.map((v) => {
            const isCurrent = v.idx === head;
            return (
              <li
                key={v.idx}
                data-testid={`version-item-${v.idx}`}
                className={`border-b border-neutral-800 px-3 py-2 ${
                  isCurrent ? "bg-neutral-900" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-300">
                    v{v.idx}
                  </span>
                  {isCurrent && (
                    <span
                      data-testid={`version-current-${v.idx}`}
                      className="rounded bg-blue-500/20 px-1.5 py-0.5 text-xs text-blue-400"
                    >
                      current
                    </span>
                  )}
                  <span className="ml-auto text-xs text-neutral-500">
                    {formatTimestamp(v.ts)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-neutral-400">{v.label}</p>
                <p className="mt-0.5 text-xs text-neutral-600">
                  {formatTokens(v.tokensTotal)} · {formatBytes(v.sizeBytes)}
                </p>
                <div className="mt-1.5 flex gap-2">
                  <button
                    data-testid={`version-diff-${v.idx}`}
                    onClick={() => onViewDiff(v.idx, head)}
                    disabled={v.idx === head}
                    className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                  >
                    View diff
                  </button>
                  <button
                    data-testid={`version-restore-${v.idx}`}
                    onClick={() => onRestore(v.idx)}
                    disabled={v.idx === head || restoreBlockedReason !== null}
                    title={restoreBlockedReason ?? undefined}
                    className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                  >
                    Restore
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
