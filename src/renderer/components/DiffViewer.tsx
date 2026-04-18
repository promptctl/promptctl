import { useState } from "react";
import type { DiffEntry, MessageSummary, VersionInfo } from "../../shared/types";

function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  const sign = tokens > 0 ? "+" : "-";
  const abs = Math.abs(tokens);
  if (abs < 1000) return `${sign}${abs}`;
  return `${sign}${(abs / 1000).toFixed(1)}k`;
}

interface DiffViewerProps {
  fromVersion: VersionInfo;
  toVersion: VersionInfo;
  entries: DiffEntry[];
  onClose: () => void;
}

export function DiffViewer({
  fromVersion,
  toVersion,
  entries,
  onClose,
}: DiffViewerProps) {
  const tokenDelta = toVersion.tokensTotal - fromVersion.tokensTotal;

  return (
    <div
      data-testid="diff-viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-[80vw] max-w-4xl flex-col rounded-lg border border-neutral-700 bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div>
            <h3 className="text-base font-medium text-neutral-200">
              v{fromVersion.idx} → v{toVersion.idx}
            </h3>
            <p className="mt-0.5 text-sm text-neutral-500">
              {toVersion.label}{" "}
              <span
                data-testid="token-delta"
                className={
                  tokenDelta < 0
                    ? "text-green-400"
                    : tokenDelta > 0
                      ? "text-red-400"
                      : "text-neutral-500"
                }
              >
                ({formatTokens(tokenDelta)} tokens)
              </span>
            </p>
          </div>
          <button
            data-testid="diff-close"
            onClick={onClose}
            className="text-sm text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {entries.length === 0 ? (
            <p className="text-sm text-neutral-500">No differences.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry, i) => (
                <DiffEntryRow key={i} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffEntryRow({ entry }: { entry: DiffEntry }) {
  const [expanded, setExpanded] = useState(false);

  if (entry.kind === "unchanged") {
    return (
      <li
        data-testid="diff-unchanged"
        className="rounded border border-neutral-800 px-3 py-2 text-xs text-neutral-500"
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="hover:text-neutral-300"
        >
          {entry.count} message{entry.count === 1 ? "" : "s"} unchanged
          {expanded ? " ▼" : " ▶"}
        </button>
      </li>
    );
  }

  if (entry.kind === "removed") {
    return (
      <li
        data-testid="diff-removed"
        className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2"
      >
        <p className="text-xs font-medium text-red-400">
          − Removed ({entry.messages.length})
        </p>
        <ul className="mt-1 space-y-1">
          {entry.messages.map((m) => (
            <MessageLine key={m.id} message={m} color="red" />
          ))}
        </ul>
      </li>
    );
  }

  if (entry.kind === "added") {
    return (
      <li
        data-testid="diff-added"
        className="rounded border border-green-900/50 bg-green-950/30 px-3 py-2"
      >
        <p className="text-xs font-medium text-green-400">
          + Added ({entry.messages.length})
        </p>
        <ul className="mt-1 space-y-1">
          {entry.messages.map((m) => (
            <MessageLine key={m.id} message={m} color="green" />
          ))}
        </ul>
      </li>
    );
  }

  // modified
  const tokenDelta = entry.after.tokens - entry.before.tokens;
  const tokenDeltaLabel =
    tokenDelta < 0
      ? `−${entry.before.tokens - entry.after.tokens} tokens`
      : tokenDelta > 0
        ? `+${tokenDelta} tokens`
        : "no token change";
  const tokenDeltaColor =
    tokenDelta < 0
      ? "text-green-400"
      : tokenDelta > 0
        ? "text-red-400"
        : "text-neutral-500";

  return (
    <li
      data-testid="diff-modified"
      className="rounded border border-yellow-900/50 bg-yellow-950/20 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-yellow-400">~ Modified</p>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
          {entry.before.type}
        </span>
        <span
          data-testid="modified-token-delta"
          className={`text-xs font-medium ${tokenDeltaColor}`}
        >
          {entry.before.tokens} → {entry.after.tokens} tok ({tokenDeltaLabel})
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-xs text-neutral-500 hover:text-neutral-300"
        >
          {expanded ? "Hide content" : "Show content"}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="mb-1 text-neutral-500">Before:</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-950/20 p-2 text-red-300">
              {entry.before.preview || `[${entry.before.type}]`}
            </pre>
          </div>
          <div>
            <p className="mb-1 text-neutral-500">After:</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-green-950/20 p-2 text-green-300">
              {entry.after.preview || `[${entry.after.type}]`}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

function MessageLine({
  message,
  color,
}: {
  message: MessageSummary;
  color: "red" | "green" | "neutral";
}) {
  const textColor =
    color === "red"
      ? "text-red-300"
      : color === "green"
        ? "text-green-300"
        : "text-neutral-300";
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
        {message.type}
      </span>
      <span className={`flex-1 truncate ${textColor}`} title={message.preview}>
        {message.preview || `[${message.type}]`}
      </span>
      <span className="text-neutral-600">{message.tokens} tok</span>
    </li>
  );
}
