import { useEffect, useState, useCallback } from "react";
import { useSessionStore } from "../store/sessions";
import type {
  GeminiMessageSummary,
  GeminiMessageFlag,
  GeminiProject,
  GeminiSessionInfo,
} from "../../shared/types";

// -- Formatting helpers --

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

function relativeTime(ts: string): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// -- Constants --

const TYPE_COLORS: Record<string, string> = {
  user: "bg-blue-500/20 text-blue-400",
  gemini: "bg-emerald-500/20 text-emerald-400",
  info: "bg-neutral-500/20 text-neutral-400",
};

const FLAG_LABELS: Record<
  GeminiMessageFlag,
  { label: string; color: string; tip: string }
> = {
  oversized: {
    label: "LARGE",
    color: "text-orange-400 bg-orange-500/20",
    tip: "Over 50KB. Usually a large tool output (file read, search result). Safe to cut if Gemini already summarized its contents.",
  },
  repetitive: {
    label: "REPEAT",
    color: "text-red-400 bg-red-500/20",
    tip: "Contains repeated phrases. Likely a model loop / degenerate output. Almost always safe to remove.",
  },
  "loop-detection": {
    label: "LOOP",
    color: "text-red-400 bg-red-500/20",
    tip: "System loop-detection message. The conversation crashed here. Remove this and the messages around it.",
  },
  "tool-output": {
    label: "TOOL",
    color: "text-neutral-400 bg-neutral-700",
    tip: "Contains tool calls or results. Review before cutting \u2014 the model may reference these results later.",
  },
  "system-noise": {
    label: "NOISE",
    color: "text-neutral-500 bg-neutral-800",
    tip: "System/info message with no conversational value. Safe to remove.",
  },
};

// -- Guidance --

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="shrink-0 space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold text-neutral-200">
          How Session Editing Works
        </h3>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
        >
          hide
        </button>
      </div>

      <div className="space-y-2 text-xs leading-relaxed text-neutral-400">
        <p>
          Gemini CLI stores conversations as a JSON array of messages. The model
          has
          <strong className="text-neutral-300"> zero memory </strong>
          beyond this array &mdash; if a message isn&apos;t there, it never
          happened. You can surgically edit the history to remove bad outputs,
          tangents, and bloat, then resume.
        </p>

        <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
          <p className="mb-1.5 font-medium text-neutral-300">Workflow:</p>
          <ol className="list-inside list-decimal space-y-1 text-neutral-400">
            <li>
              <strong className="text-orange-400">Auto-Trim</strong> &mdash;
              removes obvious junk (loops, noise)
            </li>
            <li>
              <strong className="text-orange-400">+Oversized</strong> to flag
              large tool outputs, then preview to decide
            </li>
            <li>
              Manually cut off-topic tangents or frustrated back-and-forth
            </li>
            <li>
              <strong className="text-red-400">Save</strong> &mdash; original
              is backed up as{" "}
              <code className="text-neutral-500">.backup</code>
            </li>
            <li>
              Resume:{" "}
              <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                gemini --resume latest
              </code>
            </li>
            <li>
              First message:{" "}
              <em className="text-neutral-300">
                &quot;Summarize where we are and what&apos;s next&quot;
              </em>
            </li>
          </ol>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
            <p className="mb-1 font-medium text-neutral-300">Safe to remove:</p>
            <ul className="list-inside list-disc space-y-0.5">
              <li>
                <span className="text-red-400">REPEAT</span> /{" "}
                <span className="text-red-400">LOOP</span> &mdash; always
              </li>
              <li>
                <span className="text-neutral-500">NOISE</span> &mdash; always
              </li>
              <li>
                <span className="text-orange-400">LARGE</span> tool outputs
                already summarized
              </li>
              <li>Tangents / correction loops</li>
            </ul>
          </div>
          <div className="rounded border border-yellow-900/50 bg-yellow-950/20 p-3">
            <p className="mb-1 font-medium text-yellow-400">Be careful:</p>
            <ul className="list-inside list-disc space-y-0.5">
              <li>Messages referenced by later messages</li>
              <li>Orphaned tool call/result pairs</li>
              <li>Context supporting later conclusions</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Tree view --

function SessionTree({
  projects,
  sessionsByProject,
  expandedProjects,
  loadingProjects,
  selectedSessionId,
  onToggleProject,
  onSelectSession,
}: {
  projects: GeminiProject[];
  sessionsByProject: Record<string, GeminiSessionInfo[]>;
  expandedProjects: Set<string>;
  loadingProjects: Set<string>;
  selectedSessionId: string | null;
  onToggleProject: (path: string) => void;
  onSelectSession: (session: GeminiSessionInfo, projectPath: string) => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mb-3 space-y-1">
        <p className="text-xs text-neutral-500">
          Select a session to edit. Click a project to expand its sessions.
        </p>
      </div>

      {projects.length === 0 && (
        <p className="text-xs text-neutral-500">
          No Gemini projects found in ~/.gemini/tmp/
        </p>
      )}

      <div className="space-y-1">
        {projects.map((project) => {
          const expanded = expandedProjects.has(project.path);
          const isLoading = loadingProjects.has(project.path);
          const sessions = sessionsByProject[project.path] ?? [];

          return (
            <div key={project.path}>
              {/* Project row */}
              <button
                onClick={() => onToggleProject(project.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-neutral-800"
              >
                <span className="text-[10px] text-neutral-600">
                  {expanded ? "\u25BC" : "\u25B6"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-200">
                    {project.name}
                  </p>
                  <p className="truncate text-[10px] text-neutral-600">
                    {project.projectRoot}
                  </p>
                </div>
                {sessions.length > 0 && (
                  <span className="text-[10px] text-neutral-600">
                    {sessions.length}
                  </span>
                )}
              </button>

              {/* Sessions under this project */}
              {expanded && (
                <div className="ml-4 border-l border-neutral-800 pl-2">
                  {isLoading && (
                    <p className="px-2 py-1 text-[10px] text-neutral-600">
                      Loading sessions...
                    </p>
                  )}
                  {!isLoading && sessions.length === 0 && (
                    <p className="px-2 py-1 text-[10px] text-neutral-600">
                      No sessions
                    </p>
                  )}
                  {sessions.map((session) => {
                    const active =
                      selectedSessionId === session.sessionId;
                    const sizeWarning = session.fileSizeBytes > 5_000_000;
                    return (
                      <button
                        key={session.sessionId}
                        onClick={() =>
                          onSelectSession(session, project.path)
                        }
                        className={`mb-1 w-full rounded-md px-2 py-2 text-left transition-colors ${
                          active
                            ? "border border-blue-500/40 bg-blue-950/30"
                            : "hover:bg-neutral-800/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-medium text-neutral-300">
                            {session.summary ||
                              session.sessionId.slice(0, 8) + "..."}
                          </p>
                          <span
                            className={`shrink-0 text-[10px] ${
                              sizeWarning
                                ? "font-medium text-orange-400"
                                : "text-neutral-600"
                            }`}
                          >
                            {formatBytes(session.fileSizeBytes)}
                          </span>
                        </div>

                        <div className="mt-0.5 flex gap-2 text-[10px] text-neutral-600">
                          <span>{session.messageCount} msgs</span>
                          <span>{relativeTime(session.lastUpdated)}</span>
                        </div>

                        {/* Preview of first user messages */}
                        {session.previewMessages.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {session.previewMessages.map((preview, i) => (
                              <p
                                key={i}
                                className="truncate text-[10px] text-neutral-500"
                              >
                                <span className="text-blue-400/60">
                                  &gt;{" "}
                                </span>
                                {preview}
                              </p>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -- Message row --

function MessageRow({
  msg,
  marked,
  onToggle,
  onPreview,
  onShiftClick,
}: {
  msg: GeminiMessageSummary;
  marked: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onShiftClick: () => void;
}) {
  return (
    <div
      className={`flex items-start gap-2 border-b border-neutral-800/50 px-3 py-2 transition-colors ${
        marked ? "bg-red-950/30" : "hover:bg-neutral-900"
      }`}
    >
      <input
        type="checkbox"
        checked={marked}
        onChange={onToggle}
        onClick={(e) => {
          if (e.shiftKey) {
            e.preventDefault();
            onShiftClick();
          }
        }}
        className="mt-1 shrink-0 accent-red-500"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500">{msg.index}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_COLORS[msg.type] ?? TYPE_COLORS.info}`}
          >
            {msg.type}
          </span>
          <span className="text-[10px] text-neutral-500">
            {formatTimestamp(msg.timestamp)}
          </span>
          <span className="text-[10px] text-neutral-600">
            {formatBytes(msg.sizeBytes)}
          </span>
          {msg.flags.map((flag) => {
            const info = FLAG_LABELS[flag];
            return (
              <span
                key={flag}
                className={`cursor-help rounded px-1 py-0.5 text-[9px] font-bold ${info.color}`}
                title={info.tip}
              >
                {info.label}
              </span>
            );
          })}
        </div>
        <p
          className="mt-0.5 cursor-pointer truncate text-xs text-neutral-400 hover:text-neutral-200"
          onClick={onPreview}
          title="Click to preview full message"
        >
          {msg.preview || `[${msg.type} message]`}
        </p>
      </div>

      <button
        onClick={(e) => {
          if (e.shiftKey) onShiftClick();
          else onToggle();
        }}
        className={`shrink-0 rounded px-2 py-0.5 text-[10px] transition-colors ${
          marked
            ? "text-green-400 hover:bg-green-900/30"
            : "text-red-400 hover:bg-red-900/30"
        }`}
      >
        {marked ? "Keep" : "Cut"}
      </button>
    </div>
  );
}

// -- Preview panel --

function PreviewPanel({
  content,
  index,
  onClose,
}: {
  content: string;
  index: number;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col border-l border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-xs font-medium text-neutral-300">
          Message #{index}
        </span>
        <button
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>
      <pre className="flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-neutral-400">
        {content.length > 100_000
          ? content.slice(0, 100_000) + "\n\n... [truncated for display]"
          : content}
      </pre>
    </div>
  );
}

// -- Session stats --

function SessionStats({
  messages,
  markedCount,
  totalSize,
  markedSize,
}: {
  messages: GeminiMessageSummary[];
  markedCount: number;
  totalSize: number;
  markedSize: number;
}) {
  return (
    <div className="flex items-center gap-4 text-[11px] text-neutral-500">
      <span>{messages.length} msgs</span>
      <span>{formatBytes(totalSize)}</span>
      {markedCount > 0 && (
        <>
          <span className="text-red-400">
            -{markedCount} ({formatBytes(markedSize)})
          </span>
          <span className="text-green-400">
            = {messages.length - markedCount} msgs (
            {formatBytes(totalSize - markedSize)})
          </span>
        </>
      )}
    </div>
  );
}

// -- Main component --

export function SessionEditor() {
  const {
    projects,
    sessionsByProject,
    expandedProjects,
    loadingProjects,
    selectedSession,
    selectedProjectPath,
    messages,
    markedForRemoval,
    previewIndex,
    previewContent,
    loading,
    saving,
    autoTrimIndices,
    loadProjects,
    toggleProject,
    selectSession,
    clearSession,
    toggleMessage,
    toggleRange,
    deselectAll,
    selectFlagged,
    previewMessage,
    closePreview,
    runAutoTrim,
    applyAutoTrim,
    save,
  } = useSessionStore();

  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleToggle = useCallback(
    (index: number) => {
      toggleMessage(index);
      setLastClickedIndex(index);
    },
    [toggleMessage],
  );

  const handleShiftClick = useCallback(
    (index: number) => {
      if (lastClickedIndex !== null) {
        toggleRange(lastClickedIndex, index);
      } else {
        toggleMessage(index);
      }
      setLastClickedIndex(index);
    },
    [lastClickedIndex, toggleMessage, toggleRange],
  );

  const handleSave = useCallback(async () => {
    const result = await save();
    setSaveResult(result);
  }, [save]);

  const handleAutoTrim = useCallback(async () => {
    await runAutoTrim();
    applyAutoTrim();
  }, [runAutoTrim, applyAutoTrim]);

  const selectedProject = projects.find(
    (p) => p.path === selectedProjectPath,
  );

  const totalSize = messages.reduce((sum, m) => sum + m.sizeBytes, 0);
  const markedSize = messages
    .filter((m) => markedForRemoval.has(m.index))
    .reduce((sum, m) => sum + m.sizeBytes, 0);

  const flagCounts = messages.reduce(
    (acc, m) => {
      for (const f of m.flags) acc[f] = (acc[f] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Two-panel layout: tree on left, editor on right
  return (
    <div className="flex h-full gap-4">
      {/* Left panel: session tree */}
      <div className="w-72 shrink-0 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
        <SessionTree
          projects={projects}
          sessionsByProject={sessionsByProject}
          expandedProjects={expandedProjects}
          loadingProjects={loadingProjects}
          selectedSessionId={selectedSession?.sessionId ?? null}
          onToggleProject={toggleProject}
          onSelectSession={(session, projectPath) => {
            setSaveResult(null);
            setShowHelp(false);
            selectSession(session, projectPath);
          }}
        />
      </div>

      {/* Right panel: editor or empty state */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedSession ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-neutral-500">
              Select a session from the tree to begin editing
            </p>
            <button
              onClick={() => setShowHelp(true)}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            >
              How does this work?
            </button>
            {showHelp && (
              <div className="w-full max-w-2xl">
                <HelpPanel onClose={() => setShowHelp(false)} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col gap-3 overflow-hidden">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={clearSession}
                  className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  &larr;
                </button>
                <div>
                  <p className="text-sm font-medium text-neutral-200">
                    {selectedSession.summary ||
                      selectedSession.sessionId.slice(0, 8)}
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    {selectedProject?.projectRoot} &middot;{" "}
                    {relativeTime(selectedSession.lastUpdated)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {saveResult && (
                  <span className="text-xs text-green-400">
                    Saved (backup created)
                  </span>
                )}
                <button
                  onClick={() => setShowHelp((v) => !v)}
                  className="rounded px-2 py-1 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                >
                  {showHelp ? "Hide guide" : "Guide"}
                </button>
              </div>
            </div>

            {/* Help panel */}
            {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}

            {/* Quick stats */}
            {!loading && messages.length > 0 && (
              <div className="flex shrink-0 flex-wrap gap-2 text-[10px]">
                {Object.entries(flagCounts).map(([flag, count]) => {
                  const info = FLAG_LABELS[flag as GeminiMessageFlag];
                  return (
                    <span
                      key={flag}
                      className={`rounded px-1.5 py-0.5 ${info.color}`}
                    >
                      {count} {info.label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Toolbar */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
              <button
                onClick={handleAutoTrim}
                className="rounded bg-orange-600/20 px-2.5 py-1 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-600/30"
                title="Automatically mark repetitive, loop-detection, and system noise messages for removal"
              >
                Auto-Trim
              </button>

              <div className="h-4 w-px bg-neutral-700" />

              <button
                onClick={() => selectFlagged("oversized")}
                className="rounded px-2 py-1 text-[10px] text-orange-400 hover:bg-neutral-800"
                title="Mark all messages over 50KB"
              >
                +Oversized
                {flagCounts.oversized ? ` (${flagCounts.oversized})` : ""}
              </button>
              <button
                onClick={() => selectFlagged("repetitive")}
                className="rounded px-2 py-1 text-[10px] text-red-400 hover:bg-neutral-800"
              >
                +Repetitive
                {flagCounts.repetitive ? ` (${flagCounts.repetitive})` : ""}
              </button>
              <button
                onClick={() => selectFlagged("system-noise")}
                className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:bg-neutral-800"
              >
                +Noise
                {flagCounts["system-noise"]
                  ? ` (${flagCounts["system-noise"]})`
                  : ""}
              </button>
              <button
                onClick={() => selectFlagged("tool-output")}
                className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:bg-neutral-800"
              >
                +Tool
                {flagCounts["tool-output"]
                  ? ` (${flagCounts["tool-output"]})`
                  : ""}
              </button>

              <div className="h-4 w-px bg-neutral-700" />

              <button
                onClick={deselectAll}
                className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:bg-neutral-800"
              >
                Clear
              </button>

              <div className="flex-1" />

              <SessionStats
                messages={messages}
                markedCount={markedForRemoval.size}
                totalSize={totalSize}
                markedSize={markedSize}
              />

              <div className="h-4 w-px bg-neutral-700" />

              <button
                onClick={handleSave}
                disabled={markedForRemoval.size === 0 || saving}
                className="rounded bg-red-600/80 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-30"
                title="Remove marked messages and save. Original is backed up."
              >
                {saving
                  ? "Saving..."
                  : `Remove ${markedForRemoval.size} & Save`}
              </button>
            </div>

            {/* Resume reminder after save */}
            {saveResult && (
              <div className="shrink-0 rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3">
                <p className="text-xs text-neutral-400">
                  Saved. Original backed up. Resume with:
                </p>
                <code className="mt-1 block rounded bg-neutral-900 px-3 py-1.5 text-xs text-green-400">
                  cd {selectedProject?.projectRoot ?? "your-project"} &&
                  gemini --resume latest
                </code>
                <p className="mt-1 text-[10px] text-neutral-500">
                  First message:{" "}
                  <em className="text-neutral-400">
                    &quot;Summarize where we are and what&apos;s next&quot;
                  </em>
                </p>
              </div>
            )}

            {/* Message list + preview */}
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-800">
              <div
                className={`overflow-y-auto ${previewIndex !== null ? "w-1/2" : "w-full"}`}
              >
                {loading ? (
                  <p className="p-4 text-xs text-neutral-500">
                    Loading session...
                  </p>
                ) : (
                  messages.map((msg) => (
                    <MessageRow
                      key={msg.index}
                      msg={msg}
                      marked={markedForRemoval.has(msg.index)}
                      onToggle={() => handleToggle(msg.index)}
                      onPreview={() => previewMessage(msg.index)}
                      onShiftClick={() => handleShiftClick(msg.index)}
                    />
                  ))
                )}
              </div>

              {previewIndex !== null && (
                <div className="w-1/2">
                  <PreviewPanel
                    content={previewContent}
                    index={previewIndex}
                    onClose={closePreview}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
