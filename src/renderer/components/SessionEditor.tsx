import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { useSessionStore } from "../store/sessions";
import type {
  MessageSummary,
  FlagDefinition,
  Project,
  SessionInfo,
  ProviderUIMetadata,
  DiffEntry,
  VersionInfo,
  CompressToolsOptions,
  CompressToolsResult,
  SessionSaveResult,
  SessionSearchResult,
  SessionSearchMatch,
} from "../../shared/types";
import { ResizableSplit } from "./ResizableSplit";
import { ValidationViolationsDialog } from "./ValidationViolationsDialog";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { DiffViewer } from "./DiffViewer";
import { TaskToast } from "./TaskToast";
import { JsonlLineView } from "./jsonl-view";
import { newTaskId, useTaskSubscription } from "../store/tasks";

// -- Layout helpers --

// [LAW:single-enforcer] One place decides whether the main panel and the
// version-history pane are siblings or a resizable split. The structural
// choice is data-driven (showHistory + the panel) — no callsite branches.
function MainArea({
  showHistory,
  historyPanel,
  children,
}: {
  showHistory: boolean;
  historyPanel: ReactNode;
  children: ReactNode;
}) {
  if (showHistory) {
    return (
      <ResizableSplit
        orientation="horizontal"
        side="after"
        defaultSize={320}
        minSize={240}
        maxSize={500}
        className="h-full flex-1 pl-4"
        testId="session-editor-history-split"
      >
        <div className="flex h-full min-w-0 flex-col">{children}</div>
        {historyPanel}
      </ResizableSplit>
    );
  }
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col pl-4">{children}</div>
  );
}

// -- Formatting helpers --

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
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

// Fallback style for unknown types/flags
const FALLBACK_STYLE = "bg-neutral-500/20 text-neutral-400";

// -- Guidance --

function HelpPanel({
  onClose,
  metadata,
}: {
  onClose: () => void;
  metadata: ProviderUIMetadata;
}) {
  const { helpText, flagDefinitions } = metadata;
  return (
    <div className="shrink-0 space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold text-neutral-200">
          How Session Editing Works
        </h3>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
        >
          hide
        </button>
      </div>

      <div className="space-y-2 text-sm leading-relaxed text-neutral-400">
        <p>{helpText.description}</p>

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
                {helpText.resumeCommand}
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
              {helpText.safeToRemove.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-yellow-900/50 bg-yellow-950/20 p-3">
            <p className="mb-1 font-medium text-yellow-400">Be careful:</p>
            <ul className="list-inside list-disc space-y-0.5">
              {helpText.beCareful.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* Flag legend */}
        <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
          <p className="mb-1.5 font-medium text-neutral-300">Flag legend:</p>
          <div className="space-y-1">
            {Object.entries(flagDefinitions).map(([, def]) => (
              <p key={def.label}>
                <span className={`rounded px-1 py-0.5 text-sm font-bold ${def.color}`}>
                  {def.label}
                </span>{" "}
                &mdash; {def.tip}
              </p>
            ))}
          </div>
        </div>

        {/* Advanced tools */}
        <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
          <p className="mb-1.5 font-medium text-neutral-300">Advanced tools:</p>
          <dl className="space-y-2">
            <div>
              <dt>
                <span className="rounded bg-violet-600/20 px-1.5 py-0.5 text-sm font-semibold text-violet-400">
                  Smart Compress
                </span>
              </dt>
              <dd className="mt-1 ml-0.5 text-neutral-400">
                Sends the conversation to the configured LLM and asks it to
                identify messages whose content is already summarized
                elsewhere or no longer needed. Runs after Auto-Trim when the
                conversation is still large.
              </dd>
            </div>
            <div>
              <dt>
                <span className="rounded bg-cyan-600/20 px-1.5 py-0.5 text-sm font-semibold text-cyan-400">
                  Topic Focus
                </span>
              </dt>
              <dd className="mt-1 ml-0.5 text-neutral-400">
                Clicking the button segments the conversation into topic
                blocks so you can see its structure at a glance. Entering a
                query (e.g. <em>&quot;auth refactor&quot;</em>) additionally
                marks every off-topic segment for removal. Click any chip to
                flip its kept/removed state.
              </dd>
            </div>
            <div>
              <dt>
                <span className="rounded bg-emerald-600/20 px-1.5 py-0.5 text-sm font-semibold text-emerald-400">
                  Compress Tools
                </span>
              </dt>
              <dd className="mt-1 ml-0.5 text-neutral-400">
                Rewrites bulky tool results in place instead of removing
                them: LLM-summarizes the largest, middle-truncates medium
                ones, keeps the last few untouched. Thresholds are
                configurable in Settings.
              </dd>
            </div>
            <div>
              <dt>
                <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-sm font-semibold text-neutral-300">
                  History &middot; Undo &middot; Redo
                </span>
              </dt>
              <dd className="mt-1 ml-0.5 text-neutral-400">
                Every save creates a version. Undo/Redo step through them;
                History opens a panel where you can diff any two versions or
                restore an older one. Saves are never destructive.
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

// -- Rich tooltip for toolbar actions --
// [LAW:one-type-per-behavior] Every toolbar tool shares the same hover-card
// shape: title, summary, when-to-use, example. A single component renders
// all of them from data — no per-button special cases.

interface ToolHoverCardContent {
  title: string;
  summary: string;
  whenToUse: string;
  example?: string;
}

function ToolHoverCard({
  children,
  info,
}: {
  children: ReactNode;
  info: ToolHoverCardContent;
}) {
  // React state drives visibility rather than a CSS-only :hover toggle. The
  // tooltip is only in the DOM when the user actually points at the tool, so
  // accessibility tools (and tests) see only the button's own label. Focus
  // events mirror mouse events so keyboard users get the same affordance.
  // [LAW:one-source-of-truth] One boolean — rendered or not — no CSS/DOM split.
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-0 z-50 mt-1 w-72 rounded-md border border-neutral-700 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-300 shadow-xl"
        >
          <span className="mb-1 block font-semibold text-neutral-100">
            {info.title}
          </span>
          <span className="mb-1.5 block text-neutral-400">{info.summary}</span>
          <span className="mb-0.5 block text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
            When to use
          </span>
          <span className="block text-neutral-400">{info.whenToUse}</span>
          {info.example && (
            <>
              <span className="mt-1.5 mb-0.5 block text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
                Example
              </span>
              <span className="block rounded bg-neutral-900 px-1.5 py-1 font-mono text-[11px] text-neutral-300">
                {info.example}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

// Per-tool hover-card data. Kept as module data so the toolbar JSX stays
// declarative and the content is easy to review in one place.
const TOOL_HOVER_INFO: Record<string, ToolHoverCardContent> = {
  autoTrim: {
    title: "Auto-Trim",
    summary:
      "Marks repetitive, loop-detection, and system-noise messages for removal using local heuristics — no API call, no cost.",
    whenToUse:
      "First pass on any conversation. It only flags obvious junk, so it's safe to run before anything else.",
  },
  smartCompress: {
    title: "Smart Compress",
    summary:
      "Sends the conversation to the configured LLM and asks it to identify messages whose content is already summarized elsewhere or no longer needed.",
    whenToUse:
      "After Auto-Trim, when the conversation is still large and you want a smarter pass that understands redundant back-and-forth.",
    example: "Marks failed attempts that were superseded by a later fix.",
  },
  topicFocus: {
    title: "Topic Focus",
    summary:
      "Splits the conversation into topic segments. Click the button to just see the segments. Enter a query below to mark everything off-topic for removal.",
    whenToUse:
      "When a long session spans several unrelated threads and you only want to carry one forward.",
    example: 'Query: "authentication rewrite" → keeps auth work, marks the rest.',
  },
  compressTools: {
    title: "Compress Tools",
    summary:
      "Rewrites bulky tool results in place: LLM-summarizes the largest, middle-truncates medium ones, keeps the last N untouched. Configure thresholds in Settings.",
    whenToUse:
      "When tool output dominates the token count but you still need the structural context those calls provide.",
  },
  undo: {
    title: "Undo",
    summary:
      "Revert the session file to the previous version. Every save creates a version, so undo is safe and reversible with Redo.",
    whenToUse: "After any save that went further than you intended.",
  },
  redo: {
    title: "Redo",
    summary: "Reapply a version you just undid.",
    whenToUse: "Immediately after an Undo if you changed your mind.",
  },
  history: {
    title: "Version History",
    summary:
      "Browse every saved version of this session. Compare any two versions with a diff viewer, or restore an older one.",
    whenToUse:
      "When you want to audit what changed across several saves or roll back more than one step.",
  },
  clear: {
    title: "Clear Selection",
    summary: "Uncheck every message currently marked for removal.",
    whenToUse: "When you want to start over without changing any files.",
  },
  invert: {
    title: "Invert Selection",
    summary: "Flip the marked/unmarked state of every message.",
    whenToUse:
      'When it\'s easier to pick what to KEEP — mark those, then Invert to mark the rest for removal.',
  },
  copy: {
    title: "Copy Marked",
    summary:
      "Copy the full text of every marked message to the clipboard, in order.",
    whenToUse:
      "When you want to paste the removed context into a note or feed it to another tool before deleting it here.",
  },
  save: {
    title: "Remove Marked & Save",
    summary:
      "Writes a new session file with the marked messages removed. The prior version is preserved in history — nothing is lost.",
    whenToUse: "When you're ready to commit the edits.",
  },
};

// -- Peek UI --
// Non-destructive preview of a session's messages. Loaded via the stateless
// `session:peek` IPC — does NOT mutate the editor's active-adapter state, so
// the user can flip through results without affecting any open session.

function PeekMessageRow({
  msg,
  typeStyles,
}: {
  msg: MessageSummary;
  typeStyles: Record<string, { label: string; color: string }>;
}) {
  const typeStyle = typeStyles[msg.type];
  const label = typeStyle?.label ?? msg.type;
  const color = typeStyle?.color ?? FALLBACK_STYLE;
  return (
    <div className="border-b border-neutral-800/60 px-3 py-2 last:border-b-0">
      <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
        <span className={`rounded px-1 py-0.5 font-medium ${color}`}>
          {label}
        </span>
        <span>#{msg.index}</span>
        {msg.timestamp && <span>{formatTimestamp(msg.timestamp)}</span>}
        <span className="ml-auto">{formatTokens(msg.tokens)}</span>
      </div>
      <p className="line-clamp-3 text-sm text-neutral-400">{msg.preview}</p>
    </div>
  );
}

function PeekPanel({
  result,
  messages,
  loading,
  error,
  providerMetadata,
  onClose,
  onOpen,
}: {
  result: SessionSearchResult;
  messages: MessageSummary[] | null;
  loading: boolean;
  error: string | null;
  providerMetadata: Record<string, ProviderUIMetadata>;
  onClose: () => void;
  onOpen: () => void;
}) {
  const providerMeta = providerMetadata[result.provider];
  const typeStyles = providerMeta?.typeStyles ?? {};

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50">
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-neutral-800 p-3">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-neutral-200">
            {result.summary || result.sessionId.slice(0, 12) + "..."}
          </p>
          <p className="truncate text-xs text-neutral-500">
            {result.projectName} · {relativeTime(result.lastUpdated)} ·{" "}
            {result.messageCount} msgs · {formatBytes(result.fileSizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onOpen}
            className="rounded border border-blue-500/40 bg-blue-950/30 px-2 py-1 text-xs font-medium text-blue-200 hover:border-blue-500/70 hover:bg-blue-900/40"
          >
            Open in Editor
          </button>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="p-4 text-sm text-neutral-500">Loading preview...</p>
        )}
        {error && !loading && (
          <div className="m-3 rounded-md border border-red-800/60 bg-red-950/40 p-3">
            <p className="text-sm font-semibold text-red-300">
              Failed to load preview
            </p>
            <p className="mt-1 font-mono text-xs whitespace-pre-wrap text-red-200/80">
              {error}
            </p>
          </div>
        )}
        {!loading && !error && messages && messages.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">
            This session has no visible messages.
          </p>
        )}
        {!loading && !error && messages && messages.length > 0 && (
          <div>
            {messages.map((m) => (
              <PeekMessageRow key={m.index} msg={m} typeStyles={typeStyles} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Search UI --

// Renders a text snippet with the matched substring highlighted via <mark>.
// Uses pre-computed matchStart/matchEnd offsets so we don't re-run regex here —
// that would re-do work and risk escaping bugs with special characters.
function HighlightedSnippet({ match }: { match: SessionSearchMatch }) {
  const before = match.snippet.slice(0, match.matchStart);
  const hit = match.snippet.slice(match.matchStart, match.matchEnd);
  const after = match.snippet.slice(match.matchEnd);
  return (
    <p className="truncate font-mono text-sm leading-relaxed text-neutral-400">
      <span className="text-neutral-600">&hellip;</span>
      {before}
      <mark className="rounded-sm bg-yellow-400/30 px-0.5 text-yellow-100">
        {hit}
      </mark>
      {after}
      <span className="text-neutral-600">&hellip;</span>
    </p>
  );
}

// Input that sits at the top of the left panel across both modes (tree / results).
// Debounce is owned here — the store action fires immediately when called, so the
// component throttles keystrokes before calling it. [LAW:locality-or-seam]
function SessionSearchInput({
  value,
  onChange,
  onClear,
  isBusy,
  isSearchActive,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  isBusy: boolean;
  isSearchActive: boolean;
}) {
  return (
    <div className="relative mb-3">
      <input
        type="text"
        placeholder="Search all session content..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClear();
          }
        }}
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 pr-8 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500/60 focus:outline-none"
        aria-label="Search session content"
      />
      {isBusy && (
        <span className="absolute top-1/2 right-8 -translate-y-1/2 text-sm text-neutral-500">
          ...
        </span>
      )}
      {isSearchActive && (
        <button
          onClick={onClear}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-sm text-neutral-500 hover:text-neutral-200"
          aria-label="Clear search"
        >
          &times;
        </button>
      )}
    </div>
  );
}

// One result card. Initially shows up to 3 snippets; expands to show the rest
// (already fetched — no second IPC round-trip).
function SearchResultCard({
  result,
  providerBadge,
  isPeekTarget,
  onPeek,
  onOpen,
}: {
  result: SessionSearchResult;
  providerBadge: { label: string; color: string } | undefined;
  isPeekTarget: boolean;
  onPeek: () => void;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const INITIAL = 3;
  const visibleMatches = expanded
    ? result.matches
    : result.matches.slice(0, INITIAL);
  const hasMore = result.matches.length > INITIAL || result.matchesTruncated;

  return (
    <div
      className={`rounded-md border bg-neutral-900/60 p-3 transition-colors ${
        isPeekTarget
          ? "border-blue-500/60 ring-1 ring-blue-500/30"
          : "border-neutral-800 hover:border-neutral-700"
      }`}
    >
      {/* Header: clickable — opens a non-destructive PEEK (search stays intact).
          Explicit "Open" button below commits to the editor. */}
      <button onClick={onPeek} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-base font-medium text-neutral-200">
            {result.summary || result.sessionId.slice(0, 12) + "..."}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {providerBadge && (
              <span
                className={`rounded px-1 py-0.5 text-xs font-medium ${providerBadge.color}`}
              >
                {providerBadge.label}
              </span>
            )}
            <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs font-semibold text-yellow-300">
              {result.totalMatches} match
              {result.totalMatches === 1 ? "" : "es"}
            </span>
          </div>
        </div>
        <div className="mt-0.5 flex gap-2 text-sm text-neutral-500">
          <span>{result.messageCount} msgs</span>
          <span>{formatBytes(result.fileSizeBytes)}</span>
          <span>{relativeTime(result.lastUpdated)}</span>
        </div>
      </button>

      {/* Snippets */}
      <div className="mt-2 space-y-1.5">
        {visibleMatches.map((m, i) => (
          <div key={i} className="flex items-start gap-2">
            {m.messageRole && (
              <span className="mt-0.5 shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
                {m.messageRole}
              </span>
            )}
            <HighlightedSnippet match={m} />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        {hasMore ? (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            {expanded
              ? "Show fewer"
              : `See all ${result.totalMatches} matches${
                  result.matchesTruncated
                    ? ` (first ${result.matches.length} shown)`
                    : ""
                }`}
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onOpen}
          className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-blue-500/60 hover:text-neutral-100"
        >
          Open in Editor
        </button>
      </div>
    </div>
  );
}

// Second-stage filter — narrows an already-loaded result set by substring
// match across summary, project name, session id, and every match snippet.
// Client-side only; no IPC. [LAW:locality-or-seam] Filter state lives inside
// SessionSearchResults because it's meaningful only while results are on screen.
function applyResultsFilter(
  results: SessionSearchResult[],
  filter: string,
): SessionSearchResult[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return results;
  return results.filter((r) => {
    if (r.summary.toLowerCase().includes(needle)) return true;
    if (r.projectName.toLowerCase().includes(needle)) return true;
    if (r.sessionId.toLowerCase().includes(needle)) return true;
    return r.matches.some((m) => m.snippet.toLowerCase().includes(needle));
  });
}

function SessionSearchResults({
  results,
  status,
  progressMessage,
  errorMessage,
  providerMetadata,
  onPeek,
  onOpen,
  peekFilePath,
  outerQuery,
}: {
  results: SessionSearchResult[];
  status: "idle" | "running" | "done" | "error";
  progressMessage: string | null;
  errorMessage: string | null;
  providerMetadata: Record<string, ProviderUIMetadata>;
  onPeek: (result: SessionSearchResult) => void;
  onOpen: (result: SessionSearchResult) => void;
  peekFilePath: string | null;
  outerQuery: string;
}) {
  // Filter persists while the user refines, but resets automatically when a
  // new outer search starts — otherwise a stale filter from query A could
  // silently hide results for query B.
  const [filter, setFilter] = useState("");
  useEffect(() => {
    setFilter("");
  }, [outerQuery]);

  const filtered = applyResultsFilter(results, filter);
  const filterActive = filter.trim().length > 0;

  // Group results by projectName. `results` arrives sorted by recency (main
  // process + renderer-side post-batch sort); iterating in order and grouping
  // via a Map preserves within-group recency AND orders projects by their
  // most-recent session's position.
  const groups = new Map<string, SessionSearchResult[]>();
  for (const r of filtered) {
    const list = groups.get(r.projectName) ?? [];
    list.push(r);
    groups.set(r.projectName, list);
  }

  const totalMatches = results.reduce((sum, r) => sum + r.totalMatches, 0);
  const filteredMatches = filtered.reduce((sum, r) => sum + r.totalMatches, 0);

  const summaryLabel =
    status === "running"
      ? results.length > 0
        ? `Searching... ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"} so far`
        : (progressMessage ?? "Searching...")
      : status === "done"
        ? `${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"}`
        : status === "error"
          ? "Search failed"
          : "";

  const filterCountLabel = filterActive
    ? `${filteredMatches} / ${totalMatches} matches · ${filtered.length} / ${results.length} sessions`
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Status line + in-results filter. Filter is disabled until at least
          one result has arrived so users aren't tempted to type into a dead
          input during initial spin-up. */}
      <div className="mb-3 flex shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between text-sm text-neutral-400">
          <span>{summaryLabel}</span>
          {filterCountLabel && (
            <span className="text-xs text-neutral-500">{filterCountLabel}</span>
          )}
        </div>
        <div className="relative">
          <input
            type="text"
            placeholder="Filter results..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter) {
                e.preventDefault();
                setFilter("");
              }
            }}
            disabled={results.length === 0}
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none disabled:opacity-50"
            aria-label="Filter results"
          />
          {filterActive && (
            <button
              onClick={() => setFilter("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-sm text-neutral-500 hover:text-neutral-200"
              aria-label="Clear results filter"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {status === "error" && (
        <div className="mb-3 shrink-0 rounded-md border border-red-800/60 bg-red-950/40 p-3">
          <p className="text-sm font-semibold text-red-300">Search failed</p>
          <p className="mt-1 font-mono text-xs whitespace-pre-wrap text-red-200/80">
            {errorMessage ?? "Unknown error"}
          </p>
          <p className="mt-2 text-xs text-red-300/70">
            Check the main-process console for the full stack trace.
          </p>
        </div>
      )}

      {status === "done" && results.length === 0 && (
        <p className="text-sm text-neutral-500">
          No sessions matched your query.
        </p>
      )}

      {filterActive && filtered.length === 0 && results.length > 0 && (
        <p className="text-sm text-neutral-500">
          No results match the filter &ldquo;{filter.trim()}&rdquo;.
        </p>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {[...groups.entries()].map(([projectName, items]) => (
          <div key={projectName}>
            <div className="mb-1 flex items-center gap-2 border-b border-neutral-800 pb-1">
              <p className="text-sm font-semibold text-neutral-400">
                {projectName}
              </p>
              <span className="text-xs text-neutral-600">
                {items.length} session{items.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="space-y-2">
              {items.map((r) => (
                <SearchResultCard
                  key={r.filePath}
                  result={r}
                  providerBadge={providerMetadata[r.provider]?.badge}
                  isPeekTarget={peekFilePath === r.filePath}
                  onPeek={() => onPeek(r)}
                  onOpen={() => onOpen(r)}
                />
              ))}
            </div>
          </div>
        ))}
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
  providerMetadata,
  onToggleProject,
  onSelectSession,
}: {
  projects: Project[];
  sessionsByProject: Record<string, SessionInfo[]>;
  expandedProjects: Set<string>;
  loadingProjects: Set<string>;
  selectedSessionId: string | null;
  providerMetadata: Record<string, ProviderUIMetadata>;
  onToggleProject: (project: Project) => void;
  onSelectSession: (session: SessionInfo, project: Project) => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mb-3 space-y-1">
        <p className="text-sm text-neutral-500">
          Select a session to edit. Click a project to expand its sessions.
        </p>
      </div>

      {projects.length === 0 && (
        <p className="text-sm text-neutral-500">
          No projects found. Check that session data exists.
        </p>
      )}

      <div className="space-y-1">
        {projects.map((project) => {
          const projectKey = project.projectRoot;
          const expanded = expandedProjects.has(projectKey);
          const isLoading = loadingProjects.has(projectKey);
          const sessions = sessionsByProject[projectKey] ?? [];
          const badge = providerMetadata[project.provider]?.badge;

          return (
            <div key={`${project.provider}:${projectKey}`}>
              {/* Project row */}
              <button
                onClick={() => onToggleProject(project)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-neutral-800"
              >
                <span className="text-sm text-neutral-600">
                  {expanded ? "\u25BC" : "\u25B6"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-base font-medium text-neutral-200">
                      {project.name}
                    </p>
                    {badge && (
                      <span
                        className={`shrink-0 rounded px-1 py-0.5 text-sm font-medium ${badge.color}`}
                      >
                        {badge.label}
                      </span>
                    )}
                  </div>
                  {project.projectRoot.startsWith("/") && (
                    <p className="truncate text-sm text-neutral-600">
                      {project.projectRoot}
                    </p>
                  )}
                </div>
                {sessions.length > 0 && (
                  <span className="text-sm text-neutral-600">
                    {sessions.length}
                  </span>
                )}
              </button>

              {/* Sessions under this project */}
              {expanded && (
                <div className="ml-4 border-l border-neutral-800 pl-2">
                  {isLoading && (
                    <p className="px-2 py-1 text-sm text-neutral-600">
                      Loading sessions...
                    </p>
                  )}
                  {!isLoading && sessions.length === 0 && (
                    <p className="px-2 py-1 text-sm text-neutral-600">
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
                        onClick={() => onSelectSession(session, project)}
                        className={`mb-1 w-full rounded-md px-2 py-2 text-left transition-colors ${
                          active
                            ? "border border-blue-500/40 bg-blue-950/30"
                            : "hover:bg-neutral-800/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-base font-medium text-neutral-300">
                            {session.summary ||
                              session.sessionId.slice(0, 8) + "..."}
                          </p>
                          <span
                            className={`shrink-0 text-sm ${
                              sizeWarning
                                ? "font-medium text-orange-400"
                                : "text-neutral-600"
                            }`}
                          >
                            {formatBytes(session.fileSizeBytes)}
                          </span>
                        </div>

                        <div className="mt-0.5 flex gap-2 text-sm text-neutral-600">
                          <span>{session.messageCount} msgs</span>
                          <span>{relativeTime(session.lastUpdated)}</span>
                        </div>

                        {/* Preview of first user messages */}
                        {session.previewMessages.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {session.previewMessages.map((preview, i) => (
                              <p
                                key={i}
                                className="truncate text-sm text-neutral-500"
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
  typeColor,
  typeLabel,
  flagDefs,
  expanded,
  expandedRaw,
  onToggle,
  onPreview,
  onShiftClick,
  onToggleExpand,
}: {
  msg: MessageSummary;
  marked: boolean;
  typeColor: string;
  typeLabel: string;
  flagDefs: Record<string, FlagDefinition>;
  expanded: boolean;
  expandedRaw: unknown;
  onToggle: () => void;
  onPreview: () => void;
  onShiftClick: () => void;
  onToggleExpand: () => void;
}) {
  return (
    <div
      className={`border-b border-neutral-800/50 transition-colors ${
        marked ? "bg-red-950/30" : "hover:bg-neutral-900"
      }`}
    >
      <div
        onClick={(e) => {
          if (e.shiftKey) onShiftClick();
          else onToggle();
          onPreview();
        }}
        className="flex cursor-pointer items-start gap-2 px-3 py-2.5"
      >
        <input
          type="checkbox"
          checked={marked}
          readOnly
          className="mt-1 shrink-0 accent-red-500"
        />

        {/* Expand/collapse chevron — stops propagation so it doesn't also
            toggle the mark checkbox. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          className="mt-0.5 shrink-0 rounded text-sm text-neutral-600 hover:text-neutral-300"
          title={expanded ? "Collapse inline view" : "Expand inline view"}
          aria-label={expanded ? "Collapse row" : "Expand row"}
        >
          {expanded ? "▾" : "▸"}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-500">{msg.index}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-sm font-medium ${typeColor}`}
            >
              {typeLabel}
            </span>
            <span className="text-sm text-neutral-500">
              {formatTimestamp(msg.timestamp)}
            </span>
            <span className="text-sm text-neutral-600">
              {formatTokens(msg.tokens)}
            </span>
            {msg.flags.map((flag) => {
              const info = flagDefs[flag];
              if (!info) return null;
              return (
                <span
                  key={flag}
                  className={`cursor-help rounded px-1 py-0.5 text-sm font-bold ${info.color}`}
                  title={info.tip}
                >
                  {info.label}
                </span>
              );
            })}
            {/* Extras (model, tokens, etc.) */}
            {Object.entries(msg.extras).map(([key, value]) => (
              <span
                key={key}
                className="rounded bg-neutral-800 px-1 py-0.5 text-sm text-neutral-500"
                title={key}
              >
                {value}
              </span>
            ))}
          </div>
          <p className="mt-0.5 truncate text-base text-neutral-400">
            {msg.preview || `[${msg.type} message]`}
          </p>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onPreview();
          }}
          className="shrink-0 rounded px-2 py-0.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          View
        </button>
      </div>

      {expanded && (
        <div className="border-t border-neutral-800 bg-neutral-950/50">
          <JsonlLineView raw={expandedRaw} />
        </div>
      )}
    </div>
  );
}

// -- Preview panel --
// Renders the parsed JSONL line through JsonlLineView. The raw object is
// the source of truth; every field flows through one of the registered
// renderers — no JSON.stringify reaches the DOM. [LAW:one-source-of-truth]

function PreviewPanel({
  raw,
  index,
  onClose,
}: {
  raw: unknown;
  index: number;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col border-l border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-sm font-medium text-neutral-300">
          Message #{index}
        </span>
        <button
          onClick={onClose}
          className="rounded px-2 py-0.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <JsonlLineView raw={raw} />
      </div>
    </div>
  );
}

// -- Session stats --

function SessionStats({
  messages,
  markedCount,
  totalTokens,
  markedTokens,
}: {
  messages: MessageSummary[];
  markedCount: number;
  totalTokens: number;
  markedTokens: number;
}) {
  return (
    <div className="flex items-center gap-4 text-sm text-neutral-500">
      <span>{messages.length} msgs</span>
      <span>{formatTokens(totalTokens)}</span>
      {markedCount > 0 && (
        <>
          <span className="text-red-400">
            -{markedCount} ({formatTokens(markedTokens)})
          </span>
          <span className="text-green-400">
            = {messages.length - markedCount} msgs (
            {formatTokens(totalTokens - markedTokens)})
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
    providerMetadata,
    selectedSession,
    selectedProjectPath,
    selectedProvider,
    messages,
    markedForRemoval,
    previewIndex,
    previewRaw,
    loading,
    saving,
    versions,
    versionHead,
    loadProjects,
    toggleProject,
    selectSession,
    clearSession,
    toggleMessage,
    toggleRange,
    deselectAll,
    previewMessage,
    closePreview,
    runAutoTrim,
    applyAutoTrim,
    save,
    undo,
    redo,
    searchQuery,
    searchResults,
    searchStatus,
    searchError,
    searchTaskId,
    setSearchQuery,
    runSearch,
    clearSearch,
    selectSearchResult,
    peekResult,
    peekMessages,
    peekLoading,
    peekError,
    openPeek,
    closePeek,
  } = useSessionStore();

  // Subscribe to the search task's events so the input can show live progress
  // ("47 matches in 12 sessions") while rg streams hits.
  const searchTaskState = useTaskSubscription(searchTaskId);
  const searchProgressMessage = searchTaskState?.message ?? null;

  // Debounce: keystrokes update the input immediately (user feedback) but only
  // fire the search after 300ms of quiet. useRef holds the timer across renders;
  // we clear on every keystroke AND on unmount. [LAW:locality-or-seam]
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchInputChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => {
        void runSearch(value);
      }, 300);
    },
    [setSearchQuery, runSearch],
  );
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Any non-idle state means the main panel should show the search view:
  // running → progress, done → results (possibly empty), error → error message.
  // [LAW:dataflow-not-control-flow] The UI mode follows searchStatus, not a flag.
  const isSearchActive = searchStatus !== "idle";
  const searchIsBusy = searchStatus === "running";

  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Inline expansion — independent of the side-preview. Raw objects are
  // fetched once and cached per index. [LAW:one-source-of-truth] Adapter
  // parses the line; we keep the JS object verbatim.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [rawByIndex, setRawByIndex] = useState<Map<number, unknown>>(
    new Map(),
  );
  const toggleExpand = useCallback(async (index: number) => {
    const isExpanded = expandedRows.has(index);
    const next = new Set(expandedRows);
    if (isExpanded) {
      next.delete(index);
      setExpandedRows(next);
      return;
    }
    next.add(index);
    setExpandedRows(next);
    if (!rawByIndex.has(index)) {
      const raw = await window.electronAPI.invoke(
        "session:message-raw",
        index,
      );
      setRawByIndex((prev) => {
        const n = new Map(prev);
        n.set(index, raw);
        return n;
      });
    }
  }, [expandedRows, rawByIndex]);
  const [saveResult, setSaveResult] = useState<SessionSaveResult | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  // One active task id drives the toast. When null, no task is running and
  // interactive controls are enabled.
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const taskState = useTaskSubscription(activeTaskId);
  // Handler-owned terminal state. The IPC invoke's resolve/reject is the
  // authoritative "task finished" signal — events are just progress. If the
  // done/error event is delayed or dropped, this still renders the outcome.
  const [handlerOutcome, setHandlerOutcome] = useState<{
    status: "done" | "error" | "cancelled";
    message?: string;
  } | null>(null);
  const llmWorking = activeTaskId !== null && handlerOutcome === null;
  const [focusQuery, setFocusQuery] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  // Compression thresholds — loaded from settings, passed into the backend.
  const [compressOpts, setCompressOpts] = useState<CompressToolsOptions>({
    summarizeThreshold: 5000,
    truncateThreshold: 1000,
    keepLastN: 3,
  });
  useEffect(() => {
    void window.electronAPI
      .invoke("settings:load")
      .then((s: unknown) => {
        const cfg = s as {
          compressSummarizeThreshold?: number;
          compressTruncateThreshold?: number;
          compressKeepLastN?: number;
        };
        setCompressOpts({
          summarizeThreshold: cfg.compressSummarizeThreshold ?? 5000,
          truncateThreshold: cfg.compressTruncateThreshold ?? 1000,
          keepLastN: cfg.compressKeepLastN ?? 3,
        });
      });
  }, []);
  const [topicSegments, setTopicSegments] = useState<
    {
      topic: string;
      startIndex: number;
      endIndex: number;
      tokenCount: number;
      relevant: boolean;
    }[]
  >([]);

  const [diffState, setDiffState] = useState<{
    fromVersion: VersionInfo;
    toVersion: VersionInfo;
    entries: DiffEntry[];
  } | null>(null);

  const versionTip =
    versions.length > 0 ? versions[versions.length - 1].idx : 0;
  const canUndo = versionHead > 1;
  const canRedo = versionHead > 0 && versionHead < versionTip;

  const handleViewDiff = useCallback(
    async (fromIdx: number, toIdx: number) => {
      const fromVersion = versions.find((v) => v.idx === fromIdx);
      const toVersion = versions.find((v) => v.idx === toIdx);
      if (!fromVersion || !toVersion) return;
      const entries = await useSessionStore
        .getState()
        .diffVersions(fromIdx, toIdx);
      setDiffState({ fromVersion, toVersion, entries });
    },
    [versions],
  );

  const handleRestoreVersion = useCallback(async (idx: number) => {
    await useSessionStore.getState().restoreVersion(idx);
    setShowHistory(false);
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Reset inline-expansion state when the loaded session changes — the
  // cached raw objects belong to the previous session's index space.
  // Topic-focus state is also session-local: a query and its segments
  // describe a specific conversation and are meaningless for any other.
  // [LAW:one-source-of-truth] `selectedSession.sessionId` is the single
  // signal that a new conversation is active; all derived UI flushes from here.
  useEffect(() => {
    setExpandedRows(new Set());
    setRawByIndex(new Map());
    setFocusQuery("");
    setTopicSegments([]);
  }, [selectedSession?.sessionId]);

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
    // Versioning makes Save fearless — every save creates a recoverable version.
    const result = await save();
    setSaveResult(result);
  }, [save]);

  const handleAutoTrim = useCallback(async () => {
    await runAutoTrim();
    applyAutoTrim();
  }, [runAutoTrim, applyAutoTrim]);

  const toggleFilter = useCallback((flag: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  }, []);

  const handleCopySelected = useCallback(async () => {
    const indices = [...markedForRemoval];
    if (indices.length === 0) return;
    const content = (await window.electronAPI.invoke(
      "session:messages-content",
      indices,
    )) as string;
    window.electronAPI.writeClipboard(content);
    setCopyStatus(`Copied ${indices.length} messages`);
    setTimeout(() => setCopyStatus(null), 3000);
  }, [markedForRemoval]);

  // Centralise the task-begin/end dance so every long-running handler reuses
  // the same pattern. This is the "seam" new ops plug into — they supply an
  // async op and never worry about toast state again.
  const runHandlerTask = useCallback(
    async <T,>(op: (taskId: string) => Promise<T>): Promise<T | null> => {
      const taskId = newTaskId();
      setHandlerOutcome(null);
      setActiveTaskId(taskId);
      try {
        const result = await op(taskId);
        return result;
      } catch (e) {
        const err = e as Error;
        if (err.message && err.message.toLowerCase().includes("cancel")) {
          setHandlerOutcome({ status: "cancelled" });
        } else {
          setHandlerOutcome({
            status: "error",
            message: err.message ? `Error: ${err.message}` : "Error",
          });
        }
        return null;
      }
    },
    [],
  );

  const handleSmartCompress = useCallback(async () => {
    const suggestions = await runHandlerTask(async (taskId) => {
      return (await window.electronAPI.invoke(
        "llm:suggest-compression",
        taskId,
        messages,
      )) as { indices: number[]; reason: string }[];
    });
    if (!suggestions) return; // caught by runHandlerTask
    const next = new Set(markedForRemoval);
    let added = 0;
    for (const s of suggestions) {
      for (const i of s.indices) {
        next.add(i);
        added++;
      }
    }
    useSessionStore.setState({ markedForRemoval: next });
    const reasons = suggestions.map((s) => s.reason).join("; ");
    setHandlerOutcome({
      status: "done",
      message:
        added > 0
          ? `Marked ${added} messages: ${reasons}`
          : "No additional compression opportunities found",
    });
  }, [messages, markedForRemoval, runHandlerTask]);

  // [LAW:dataflow-not-control-flow] Segment-only and focus-and-mark share
  // one code path; the query string (empty vs non-empty) decides what the
  // backend returns and whether we touch `markedForRemoval`. Same IPC call,
  // same state updates, different data.
  const runSegmentation = useCallback(
    async (query: string) => {
      const segments = await runHandlerTask(async (taskId) => {
        return (await window.electronAPI.invoke(
          "llm:segment-topics",
          taskId,
          messages,
          query,
        )) as typeof topicSegments;
      });
      if (!segments) return;
      setTopicSegments(segments);

      const trimmed = query.trim();
      const offTopic = segments.filter((s) => !s.relevant);
      const next = new Set(markedForRemoval);
      let added = 0;
      for (const seg of offTopic) {
        for (let i = seg.startIndex; i <= seg.endIndex; i++) {
          next.add(i);
          added++;
        }
      }
      useSessionStore.setState({ markedForRemoval: next });

      if (!trimmed) {
        setHandlerOutcome({
          status: "done",
          message: `Found ${segments.length} topic segment${segments.length === 1 ? "" : "s"}. Click chips to mark for removal, or enter a focus query to mark off-topic segments automatically.`,
        });
        return;
      }

      const keptTopics = segments
        .filter((s) => s.relevant)
        .map((s) => s.topic)
        .join(", ");
      setHandlerOutcome({
        status: "done",
        message:
          added > 0
            ? `Marked ${added} off-topic messages. Keeping: ${keptTopics}`
            : `All segments relevant to "${trimmed}"`,
      });
    },
    [messages, markedForRemoval, runHandlerTask],
  );

  // Button click: segment only. The panel becomes visible with all segments
  // as "keep"; nothing is marked until the user either clicks chips or submits
  // a focus query.
  const handleSegmentTopics = useCallback(async () => {
    await runSegmentation("");
  }, [runSegmentation]);

  // Query submit from inside the segments panel: segment + mark off-topic.
  const handleApplyFocusQuery = useCallback(async () => {
    if (!focusQuery.trim()) return;
    await runSegmentation(focusQuery);
  }, [focusQuery, runSegmentation]);

  const handleCompressTools = useCallback(async () => {
    const toolResultIndices = messages
      .filter((m) => m.type === "tool-result")
      .map((m) => m.index);
    if (toolResultIndices.length === 0) {
      // Not a real task — surface the info using the outcome path so the same
      // toast component renders it and the user can dismiss.
      setActiveTaskId(newTaskId());
      setHandlerOutcome({
        status: "done",
        message: "No tool results to compress",
      });
      return;
    }
    const result = await runHandlerTask(async (taskId) => {
      return (await window.electronAPI.invoke(
        "session:compress-tools",
        taskId,
        toolResultIndices,
        compressOpts,
      )) as CompressToolsResult;
    });
    if (!result) return;

    const {
      updated,
      truncatedCount,
      summarizedCount,
      skippedTooSmall,
      skippedProtected,
    } = result;
    const byIndex = new Map(updated.map((m) => [m.index, m]));
    const nextMessages = messages.map((m) => byIndex.get(m.index) ?? m);
    useSessionStore.setState({ messages: nextMessages });
    if (updated.length > 0) {
      await useSessionStore.getState().loadVersions();
    }

    const parts: string[] = [];
    if (summarizedCount > 0) parts.push(`Summarized ${summarizedCount}`);
    if (truncatedCount > 0) parts.push(`Truncated ${truncatedCount}`);
    if (parts.length === 0) parts.push("No tool results modified");
    if (skippedTooSmall > 0) parts.push(`${skippedTooSmall} too small`);
    if (skippedProtected > 0) parts.push(`${skippedProtected} preserved`);
    setHandlerOutcome({ status: "done", message: parts.join(" · ") });
  }, [messages, compressOpts, runHandlerTask]);

  // Active provider metadata (for the currently selected session)
  const activeMetadata = selectedProvider
    ? providerMetadata[selectedProvider]
    : undefined;

  const selectedProject = projects.find(
    (p) => p.projectRoot === selectedProjectPath,
  );

  const totalTokens = messages.reduce((sum, m) => sum + m.tokens, 0);
  const markedTokens = messages
    .filter((m) => markedForRemoval.has(m.index))
    .reduce((sum, m) => sum + m.tokens, 0);

  // Filter messages by active type/flag/tool filters and search text
  const searchLower = searchText.toLowerCase();
  const filteredMessages = messages.filter((m) => {
    const matchesFilters =
      activeFilters.size === 0 ||
      activeFilters.has(`type:${m.type}`) ||
      m.flags.some((f) => activeFilters.has(`flag:${f}`)) ||
      m.toolNames.some((t) => activeFilters.has(`tool:${t}`));
    const matchesSearch =
      !searchLower ||
      m.preview.toLowerCase().includes(searchLower) ||
      m.type.toLowerCase().includes(searchLower);
    return matchesFilters && matchesSearch;
  });

  const flagCounts = messages.reduce(
    (acc, m) => {
      for (const f of m.flags) acc[f] = (acc[f] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const typeCounts = messages.reduce(
    (acc, m) => {
      acc[m.type] = (acc[m.type] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const toolNameCounts = messages.reduce(
    (acc, m) => {
      for (const name of m.toolNames) acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Resolve styles from active provider metadata
  const typeStyles = activeMetadata?.typeStyles ?? {};
  const flagDefs = activeMetadata?.flagDefinitions ?? {};

  // [LAW:dataflow-not-control-flow] Sidebar layout is invariant. Only what the
  // main panel renders depends on state: search results when a search is active,
  // editor (or empty state) otherwise. The tree stays visible so users can keep
  // browsing while results are shown.
  return (
    <div className="flex h-full">
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={320}
        minSize={240}
        maxSize={500}
        className="h-full flex-1"
        testId="session-editor-sidebar-split"
      >
        {/* Left sidebar: search input + tree. */}
        <div
          data-testid="session-editor-sidebar"
          className="flex h-full flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50 p-3"
        >
        <SessionSearchInput
          value={searchQuery}
          onChange={onSearchInputChange}
          onClear={() => {
            if (searchDebounceRef.current)
              clearTimeout(searchDebounceRef.current);
            clearSearch();
          }}
          isBusy={searchIsBusy}
          isSearchActive={isSearchActive}
        />
        <div className="flex-1 overflow-y-auto">
          <SessionTree
            projects={projects}
            sessionsByProject={sessionsByProject}
            expandedProjects={expandedProjects}
            loadingProjects={loadingProjects}
            selectedSessionId={selectedSession?.sessionId ?? null}
            providerMetadata={providerMetadata}
            onToggleProject={(project) => toggleProject(project)}
            onSelectSession={(session, project) => {
              setSaveResult(null);
              setShowHelp(false);
              selectSession(session, project);
            }}
          />
        </div>
      </div>

      <MainArea
        showHistory={showHistory && selectedSession !== null}
        historyPanel={
          <VersionHistoryPanel
            versions={versions}
            head={versionHead}
            onClose={() => setShowHistory(false)}
            onViewDiff={handleViewDiff}
            onRestore={handleRestoreVersion}
          />
        }
      >
      {/* Main panel: search results when active, otherwise editor / empty state.
          When peek is open, the main panel splits into results + preview so
          the user can read a session without discarding the search. */}
      {isSearchActive ? (
        <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
          <div
            className={`flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 ${
              peekResult ? "w-[45%] shrink-0" : "flex-1"
            }`}
          >
            <SessionSearchResults
              results={searchResults ?? []}
              status={searchStatus}
              progressMessage={searchProgressMessage}
              errorMessage={searchError}
              providerMetadata={providerMetadata}
              outerQuery={searchQuery}
              peekFilePath={peekResult?.filePath ?? null}
              onPeek={(r) => {
                void openPeek(r);
              }}
              onOpen={(r) => {
                setSaveResult(null);
                setShowHelp(false);
                void selectSearchResult(r);
              }}
            />
          </div>
          {peekResult && (
            <div className="min-w-0 flex-1">
              <PeekPanel
                result={peekResult}
                messages={peekMessages}
                loading={peekLoading}
                error={peekError}
                providerMetadata={providerMetadata}
                onClose={closePeek}
                onOpen={() => {
                  setSaveResult(null);
                  setShowHelp(false);
                  void selectSearchResult(peekResult);
                }}
              />
            </div>
          )}
        </div>
      ) : (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedSession ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-base text-neutral-500">
              Select a session from the tree to begin editing
            </p>
            <button
              onClick={() => setShowHelp(true)}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            >
              How does this work?
            </button>
            {showHelp && activeMetadata && (
              <div className="w-full max-w-2xl">
                <HelpPanel
                  onClose={() => setShowHelp(false)}
                  metadata={activeMetadata}
                />
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
                  className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  &larr;
                </button>
                <div>
                  <p className="text-base font-medium text-neutral-200">
                    {selectedSession.summary ||
                      selectedSession.sessionId.slice(0, 8)}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {selectedProject?.projectRoot} &middot;{" "}
                    {relativeTime(selectedSession.lastUpdated)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {saveResult && !saveResult.blocked && (
                  <span className="text-sm text-green-400">
                    Saved (backup created)
                  </span>
                )}
                <button
                  onClick={() => setShowHelp((v) => !v)}
                  className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                >
                  {showHelp ? "Hide guide" : "Guide"}
                </button>
              </div>
            </div>

            {/* Help panel */}
            {showHelp && activeMetadata && (
              <HelpPanel
                onClose={() => setShowHelp(false)}
                metadata={activeMetadata}
              />
            )}

            {/* Toolbar
                [LAW:locality-or-seam] The toolbar is split into two rows that
                serve different jobs: the actions row wraps freely (any width,
                any number of tools), while the save row is always a single
                line with stats on the left and the primary Save button on
                the right — so "Remove N & Save" never gets pushed off-screen
                when the window is narrow or the right panel is open. */}
            <div className="shrink-0 space-y-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
              {/* Actions row — flex-wrap so groups can flow to the next line */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* Cleanup / AI tools */}
                <div className="flex items-center gap-2">
                  <ToolHoverCard info={TOOL_HOVER_INFO.autoTrim}>
                    <button
                      onClick={handleAutoTrim}
                      className="rounded bg-orange-600/20 px-2.5 py-1 text-sm font-medium text-orange-400 transition-colors hover:bg-orange-600/30"
                    >
                      Auto-Trim
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard info={TOOL_HOVER_INFO.smartCompress}>
                    <button
                      onClick={handleSmartCompress}
                      disabled={llmWorking || messages.length === 0}
                      className="rounded bg-violet-600/20 px-2.5 py-1 text-sm font-medium text-violet-400 transition-colors hover:bg-violet-600/30 disabled:opacity-30"
                    >
                      {llmWorking ? "Analyzing..." : "Smart Compress"}
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard info={TOOL_HOVER_INFO.topicFocus}>
                    <button
                      onClick={handleSegmentTopics}
                      disabled={llmWorking || messages.length === 0}
                      className="rounded bg-cyan-600/20 px-2.5 py-1 text-sm font-medium text-cyan-400 transition-colors hover:bg-cyan-600/30 disabled:opacity-30"
                    >
                      Topic Focus
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard
                    info={{
                      ...TOOL_HOVER_INFO.compressTools,
                      summary: `${TOOL_HOVER_INFO.compressTools.summary} Current thresholds: summarize at ${compressOpts.summarizeThreshold}+ tokens, truncate at ${compressOpts.truncateThreshold}+, keep last ${compressOpts.keepLastN}.`,
                    }}
                  >
                    <button
                      onClick={handleCompressTools}
                      disabled={llmWorking || messages.length === 0}
                      className="rounded bg-emerald-600/20 px-2.5 py-1 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-600/30 disabled:opacity-30"
                    >
                      Compress Tools
                    </button>
                  </ToolHoverCard>
                </div>

                <div className="h-4 w-px bg-neutral-700" />

                {/* Versioning group */}
                <div className="flex items-center gap-1">
                  <ToolHoverCard
                    info={{
                      ...TOOL_HOVER_INFO.undo,
                      summary: canUndo
                        ? `${TOOL_HOVER_INFO.undo.summary} Next undo: ${versions[versionHead - 2]?.label ?? "previous version"}.`
                        : `${TOOL_HOVER_INFO.undo.summary} Nothing to undo.`,
                    }}
                  >
                    <button
                      data-testid="undo-button"
                      onClick={() => undo()}
                      disabled={!canUndo}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      &#8617; Undo
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard
                    info={{
                      ...TOOL_HOVER_INFO.redo,
                      summary: canRedo
                        ? `${TOOL_HOVER_INFO.redo.summary} Next redo: ${versions[versionHead]?.label ?? "next version"}.`
                        : `${TOOL_HOVER_INFO.redo.summary} Nothing to redo.`,
                    }}
                  >
                    <button
                      data-testid="redo-button"
                      onClick={() => redo()}
                      disabled={!canRedo}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      &#8618; Redo
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard info={TOOL_HOVER_INFO.history}>
                    <button
                      data-testid="history-button"
                      onClick={() => setShowHistory((v) => !v)}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800"
                    >
                      History ({versions.length})
                    </button>
                  </ToolHoverCard>
                </div>

                <div className="h-4 w-px bg-neutral-700" />

                {/* Selection group */}
                <div className="flex items-center gap-1">
                  <ToolHoverCard info={TOOL_HOVER_INFO.clear}>
                    <button
                      onClick={deselectAll}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800"
                    >
                      Clear
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard info={TOOL_HOVER_INFO.invert}>
                    <button
                      onClick={() => {
                        const next = new Set<number>();
                        for (const m of messages) {
                          if (!markedForRemoval.has(m.index)) next.add(m.index);
                        }
                        useSessionStore.setState({ markedForRemoval: next });
                      }}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800"
                    >
                      Invert
                    </button>
                  </ToolHoverCard>
                  <ToolHoverCard info={TOOL_HOVER_INFO.copy}>
                    <button
                      onClick={handleCopySelected}
                      disabled={markedForRemoval.size === 0}
                      className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      Copy
                    </button>
                  </ToolHoverCard>
                </div>
              </div>

              <div className="h-px bg-neutral-800" />

              {/* Save row — one line, stats left, primary action right, always visible */}
              <div className="flex items-center justify-between gap-3">
                <SessionStats
                  messages={messages}
                  markedCount={markedForRemoval.size}
                  totalTokens={totalTokens}
                  markedTokens={markedTokens}
                />
                <ToolHoverCard info={TOOL_HOVER_INFO.save}>
                  <button
                    onClick={handleSave}
                    disabled={markedForRemoval.size === 0 || saving}
                    className="rounded bg-red-600/80 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-30"
                  >
                    {saving
                      ? "Saving..."
                      : `Remove ${markedForRemoval.size} & Save`}
                  </button>
                </ToolHoverCard>
              </div>

              {/* Filter chips row */}
              {!loading && messages.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(typeCounts).map(([type, count]) => {
                    const style = typeStyles[type];
                    const color = style?.color ?? FALLBACK_STYLE;
                    const isFiltering = activeFilters.has(`type:${type}`);
                    return (
                      <button
                        key={`type:${type}`}
                        onClick={() => toggleFilter(`type:${type}`)}
                        className={`rounded px-2 py-1 text-sm transition-colors ${color} ${
                          isFiltering
                            ? "ring-1 ring-white/30"
                            : "opacity-70 hover:opacity-100"
                        }`}
                        title={`Filter by ${type} messages`}
                      >
                        {style?.label ?? type} ({count})
                      </button>
                    );
                  })}

                  <div className="h-4 w-px bg-neutral-700" />

                  {Object.entries(flagCounts).map(([flag, count]) => {
                    const info = flagDefs[flag];
                    if (!info) return null;
                    const isFiltering = activeFilters.has(`flag:${flag}`);
                    return (
                      <button
                        key={`flag:${flag}`}
                        onClick={() => toggleFilter(`flag:${flag}`)}
                        className={`rounded px-2 py-1 text-sm transition-colors ${info.color} ${
                          isFiltering
                            ? "ring-1 ring-white/30"
                            : "opacity-70 hover:opacity-100"
                        }`}
                        title={`Filter by ${info.label}`}
                      >
                        {info.label} ({count})
                      </button>
                    );
                  })}

                  {activeFilters.size > 0 && (
                    <button
                      onClick={() => setActiveFilters(new Set())}
                      className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              )}

              {/* Tool chips row */}
              {!loading && Object.keys(toolNameCounts).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(toolNameCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => {
                      const isFiltering = activeFilters.has(`tool:${name}`);
                      return (
                        <button
                          key={`tool:${name}`}
                          onClick={() => toggleFilter(`tool:${name}`)}
                          className={`rounded px-2 py-1 text-sm transition-colors bg-violet-500/20 text-violet-400 ${
                            isFiltering
                              ? "ring-1 ring-white/30"
                              : "opacity-70 hover:opacity-100"
                          }`}
                          title={`Filter by tool: ${name}`}
                        >
                          {name} ({count})
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Topic segments panel — visible whenever segmentation has run.
                Shows a legend so the meaning of the two chip states is
                explicit (keep vs will-be-removed), and hosts the optional
                "Focus on" query that marks off-topic segments automatically.
                [LAW:one-source-of-truth] `topicSegments` drives visibility;
                we don't keep a separate "is panel open" flag. */}
            {topicSegments.length > 0 && (
              <div className="shrink-0 space-y-2 rounded-lg border border-cyan-900/40 bg-cyan-950/10 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-neutral-200">
                    Topic Segments
                  </span>
                  <button
                    onClick={() => {
                      setTopicSegments([]);
                      setFocusQuery("");
                    }}
                    className="rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                  >
                    Dismiss
                  </button>
                </div>

                {/* Legend — removes ambiguity about which chip state is kept */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-cyan-600/20 px-1.5 py-0.5 text-cyan-400">
                      kept
                    </span>
                    <span>stays in the session</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-500 line-through">
                      removed
                    </span>
                    <span>will be deleted on Save</span>
                  </span>
                  <span className="text-neutral-500">Click any chip to toggle.</span>
                </div>

                {/* Chips */}
                <div className="flex flex-wrap gap-1.5">
                  {topicSegments.map((seg, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        const next = new Set(markedForRemoval);
                        const wasRelevant = seg.relevant;
                        for (let idx = seg.startIndex; idx <= seg.endIndex; idx++) {
                          if (wasRelevant) next.add(idx);
                          else next.delete(idx);
                        }
                        useSessionStore.setState({ markedForRemoval: next });
                        setTopicSegments(
                          topicSegments.map((s, j) =>
                            j === i ? { ...s, relevant: !s.relevant } : s,
                          ),
                        );
                      }}
                      className={`rounded px-2 py-1 text-sm transition-colors ${
                        seg.relevant
                          ? "bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30"
                          : "bg-neutral-800 text-neutral-500 line-through hover:bg-neutral-700"
                      }`}
                      title={`Messages ${seg.startIndex}-${seg.endIndex} (${formatTokens(seg.tokenCount)}). Click to toggle.`}
                    >
                      {seg.topic} ({formatTokens(seg.tokenCount)})
                    </button>
                  ))}
                </div>

                {/* Focus query input — the second triggers off the user's
                    intent. Typing a query and submitting re-runs the analysis
                    and auto-marks off-topic segments. */}
                <div className="flex items-center gap-2 border-t border-cyan-900/30 pt-2">
                  <span className="text-sm text-cyan-400">Focus on:</span>
                  <input
                    type="text"
                    value={focusQuery}
                    onChange={(e) => setFocusQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleApplyFocusQuery();
                    }}
                    placeholder='e.g. "authentication implementation" or "routing bug"'
                    className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={() => void handleApplyFocusQuery()}
                    disabled={!focusQuery.trim() || llmWorking}
                    className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-30"
                    title="Re-segment and auto-mark everything outside this topic"
                  >
                    Mark off-topic
                  </button>
                </div>
              </div>
            )}

            {/* Resume reminder after save */}
            {saveResult && !saveResult.blocked && activeMetadata && (
              <div className="shrink-0 rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3">
                <p className="text-sm text-neutral-400">
                  Saved. Original backed up. Resume with:
                </p>
                <code className="mt-1 block rounded bg-neutral-900 px-3 py-1.5 text-sm text-green-400">
                  cd {selectedProject?.projectRoot ?? "your-project"} &&{" "}
                  {activeMetadata.helpText.resumeCommand}
                </code>
                <p className="mt-1 text-sm text-neutral-500">
                  First message:{" "}
                  <em className="text-neutral-400">
                    &quot;Summarize where we are and what&apos;s next&quot;
                  </em>
                </p>
              </div>
            )}

            {/* Search + copy status */}
            <div className="flex shrink-0 items-center gap-2">
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Filter messages..."
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
              {(activeFilters.size > 0 || searchText) && (
                <span className="text-sm text-neutral-500">
                  {filteredMessages.length} / {messages.length}
                </span>
              )}
            </div>

            {/* Copy success toast */}
            {copyStatus && (
              <div className="shrink-0 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-4 py-2 text-sm text-emerald-400">
                {copyStatus}
              </div>
            )}

            {/* Message list + preview */}
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-800">
              <div
                className={`overflow-y-auto ${previewIndex !== null ? "w-1/2" : "w-full"}`}
              >
                {loading ? (
                  <p className="p-4 text-sm text-neutral-500">
                    Loading session...
                  </p>
                ) : (
                  <>
                  {filteredMessages.length > 0 && (() => {
                    const filteredIndices = filteredMessages.map((m) => m.index);
                    const allSelected = filteredIndices.every((i) => markedForRemoval.has(i));
                    const someSelected = filteredIndices.some((i) => markedForRemoval.has(i));
                    return (
                      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected;
                          }}
                          onChange={() => {
                            const next = new Set(markedForRemoval);
                            if (allSelected) {
                              for (const i of filteredIndices) next.delete(i);
                            } else {
                              for (const i of filteredIndices) next.add(i);
                            }
                            useSessionStore.setState({ markedForRemoval: next });
                          }}
                          className="shrink-0 accent-red-500"
                        />
                        <span className="text-sm text-neutral-500">
                          {allSelected
                            ? `All ${filteredIndices.length} selected`
                            : someSelected
                              ? `${filteredIndices.filter((i) => markedForRemoval.has(i)).length} of ${filteredIndices.length} selected`
                              : `Select all ${filteredIndices.length}`}
                        </span>
                      </div>
                    );
                  })()}
                  {filteredMessages.map((msg) => {
                    const style = typeStyles[msg.type];
                    return (
                      <MessageRow
                        key={msg.index}
                        msg={msg}
                        marked={markedForRemoval.has(msg.index)}
                        typeColor={style?.color ?? FALLBACK_STYLE}
                        typeLabel={style?.label ?? msg.type}
                        flagDefs={flagDefs}
                        expanded={expandedRows.has(msg.index)}
                        expandedRaw={rawByIndex.get(msg.index)}
                        onToggle={() => handleToggle(msg.index)}
                        onPreview={() =>
                          previewIndex === msg.index
                            ? closePreview()
                            : previewMessage(msg.index)
                        }
                        onShiftClick={() => handleShiftClick(msg.index)}
                        onToggleExpand={() => void toggleExpand(msg.index)}
                      />
                    );
                  })}
                  </>
                )}
              </div>

              {previewIndex !== null && (
                <div className="w-1/2">
                  <PreviewPanel
                    raw={previewRaw}
                    index={previewIndex}
                    onClose={closePreview}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      </MainArea>
      </ResizableSplit>

      {/* Diff viewer modal */}
      {diffState && (
        <DiffViewer
          fromVersion={diffState.fromVersion}
          toVersion={diffState.toVersion}
          entries={diffState.entries}
          onClose={() => setDiffState(null)}
        />
      )}

      {/* Task toast — progress bar, cancel button, post-run summary.
          Hook state drives progress; handler outcome is the terminal source
          of truth (invoke resolve/reject). */}
      <TaskToast
        taskId={activeTaskId}
        state={
          activeTaskId
            ? handlerOutcome
              ? {
                  kind: taskState?.kind ?? "",
                  label: taskState?.label ?? "",
                  done: taskState?.done ?? 0,
                  total: taskState?.total ?? 0,
                  status: handlerOutcome.status,
                  message: handlerOutcome.message,
                }
              : taskState
            : null
        }
        onClose={() => {
          setActiveTaskId(null);
          setHandlerOutcome(null);
        }}
      />

      {/* Pre-save validation surfaced structural violations (broken tool_use/
          tool_result pairing, orphaned parent refs). User can cancel and fix
          their selection, or force through for debugging. */}
      {saveResult?.blocked && (
        <ValidationViolationsDialog
          result={saveResult}
          onCancel={() => setSaveResult(null)}
          onForceSave={async () => {
            const result = await save(true);
            setSaveResult(result);
          }}
          saving={saving}
        />
      )}
    </div>
  );
}
