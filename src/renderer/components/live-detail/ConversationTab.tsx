// [LAW:dataflow-not-control-flow] Same code path for every chain shape:
// project → render. An in-flight tail, a single-request chain, and a 10-
// request chain all flow through buildTimeline → list-map. Variability
// lives in TimelineEntry's discriminated `kind`, not in branching that
// chooses which component runs.
//
// [LAW:single-enforcer] Block-level rendering goes through `renderBlock`
// (blocks.tsx); the conversation view does not hand-roll its own block
// dispatch. role badges, attribution chips, and tool-pair scroll anchors
// live here.
//
// [LAW:one-source-of-truth] No timeline cache. The useMemo key is a
// string built from (requestId, state, hasAssembledResponse) for each
// record in the chain. Per-SSE-event mutations to `events[]` don't
// touch any of those three, so the timeline isn't rebuilt on every
// chunk. A state transition (e.g. `streaming → complete`) or the
// arrival of `assembledResponse` flips the key and the projection
// re-runs. See the inline comment on the useMemo for the full rationale.

import { useEffect, useMemo, useRef } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { blockKey, renderBlock } from "./blocks";
import {
  buildTimeline,
  buildToolPairings,
  type TimelineEntry,
} from "./conversation";
import { stopReasonStyle } from "./stop-reason";

export function ConversationTab({
  chain,
  selectedRequestId,
  onSelectRequest,
}: {
  chain: RequestRecord[] | null;
  selectedRequestId: string;
  onSelectRequest?: (requestId: string) => void;
}) {
  // [LAW:types-are-the-program] The memo key must encode every dimension
  // of "did the projection result change". Three dimensions matter:
  //
  //   - requestId  → a request was added/removed from the chain
  //   - state      → a request transitioned in_flight → streaming →
  //                  complete → errored (changes whether the timeline
  //                  shows an in-flight placeholder or a real
  //                  assistant_response)
  //   - has-response → a streaming request's assembledResponse arrived
  //                    (covers the rare race where state stays the same
  //                    across the transition that populates the field)
  //
  // What is deliberately NOT in the key: the record reference (changes
  // on every SSE event, but the timeline projection doesn't), the
  // events[] array (mutates on every chunk).
  const safeChain = chain ?? [];
  const memoKey = safeChain
    .map(
      (r) =>
        `${r.requestId}:${r.state}:${r.assembledResponse !== null ? "1" : "0"}`,
    )
    .join("|");
  const timeline = useMemo(() => buildTimeline(safeChain), [memoKey]);
  const pairings = useMemo(
    () => buildToolPairings(timeline),
    [timeline],
  );

  // Auto-scroll selected request's assistant_response into view.
  // [LAW:dataflow-not-control-flow] The effect runs for every chain
  // shape and every selection change — we resolve the anchor element
  // by data attribute, not by tracking refs per entry.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const anchor = container.querySelector<HTMLElement>(
      `[data-selected-anchor="true"]`,
    );
    // jsdom (test runner) doesn't implement scrollIntoView. Guarding
    // the method's existence is correct for the prod path too — older
    // browsers without the API just no-op the auto-scroll.
    if (anchor && typeof anchor.scrollIntoView === "function") {
      anchor.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [selectedRequestId, memoKey]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-2 p-4"
      data-testid="conversation-timeline"
    >
      {timeline.length === 0 ? (
        <div className="text-sm text-neutral-500">No messages.</div>
      ) : (
        timeline.map((entry, idx) => (
          <TimelineRow
            key={timelineRowKey(entry, idx)}
            entry={entry}
            entryIndex={idx}
            selectedRequestId={selectedRequestId}
            pairings={pairings}
            onSelectRequest={onSelectRequest}
          />
        ))
      )}
    </div>
  );
}

function timelineRowKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === "message") return `m:${entry.identity}`;
  if (entry.kind === "assistant_response") return `a:${entry.identity}`;
  return `b:${entry.requestId}-${index}`;
}

function TimelineRow({
  entry,
  entryIndex,
  selectedRequestId,
  pairings,
  onSelectRequest,
}: {
  entry: TimelineEntry;
  entryIndex: number;
  selectedRequestId: string;
  pairings: ReturnType<typeof buildToolPairings>;
  onSelectRequest?: (requestId: string) => void;
}) {
  if (entry.kind === "request_boundary") {
    return (
      <BoundaryRow
        entry={entry}
        active={entry.requestId === selectedRequestId}
        onSelectRequest={onSelectRequest}
      />
    );
  }
  if (entry.kind === "message") {
    return (
      <MessageRow
        entry={entry}
        entryIndex={entryIndex}
        selectedRequestId={selectedRequestId}
        pairings={pairings}
        onSelectRequest={onSelectRequest}
      />
    );
  }
  return (
    <AssistantResponseRow
      entry={entry}
      entryIndex={entryIndex}
      selectedRequestId={selectedRequestId}
      pairings={pairings}
      onSelectRequest={onSelectRequest}
    />
  );
}

// ─── Boundary row ─────────────────────────────────────────────────────────

function BoundaryRow({
  entry,
  active,
  onSelectRequest,
}: {
  entry: Extract<TimelineEntry, { kind: "request_boundary" }>;
  active: boolean;
  onSelectRequest?: (requestId: string) => void;
}) {
  const style = stopReasonStyle(entry.stopReason);
  const ttfbMs = entry.ttfbNs !== null ? msFromNs(entry.ttfbNs) : null;
  const durMs = entry.durationNs !== null ? msFromNs(entry.durationNs) : null;
  const usageTotal = entry.usage
    ? entry.usage.input_tokens + entry.usage.output_tokens
    : null;
  return (
    <div
      data-testid="conversation-boundary"
      data-request-id={entry.requestId}
      data-active={active ? "true" : "false"}
      className={`sticky top-0 z-10 flex items-center gap-3 rounded border px-3 py-1.5 font-mono text-[11px] ${
        active
          ? "border-neutral-600 bg-neutral-900"
          : "border-neutral-800 bg-neutral-950"
      }`}
    >
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 ${style.className}`}
      >
        {style.label}
      </span>
      <RequestIdLink
        requestId={entry.requestId}
        onSelectRequest={onSelectRequest}
        className="text-neutral-400"
        testId="conversation-boundary-request-link"
      />
      {ttfbMs !== null ? (
        <span className="text-neutral-500" data-testid="conversation-boundary-ttfb">
          TTFB {ttfbMs}ms
        </span>
      ) : null}
      {durMs !== null ? (
        <span className="text-neutral-500" data-testid="conversation-boundary-duration">
          Δ {durMs}ms
        </span>
      ) : null}
      {usageTotal !== null ? (
        <span className="text-neutral-500" data-testid="conversation-boundary-tokens">
          {entry.usage?.input_tokens ?? 0}↓ {entry.usage?.output_tokens ?? 0}↑ tok
        </span>
      ) : null}
    </div>
  );
}

// ─── Message row ──────────────────────────────────────────────────────────

function MessageRow({
  entry,
  entryIndex,
  selectedRequestId,
  pairings,
  onSelectRequest,
}: {
  entry: Extract<TimelineEntry, { kind: "message" }>;
  entryIndex: number;
  selectedRequestId: string;
  pairings: ReturnType<typeof buildToolPairings>;
  onSelectRequest?: (requestId: string) => void;
}) {
  const isSelected = entry.introducedByRequestId === selectedRequestId;
  const blocks = Array.isArray(entry.content) ? entry.content : null;
  return (
    <EntryShell
      role={entry.role}
      introducedByRequestId={entry.introducedByRequestId}
      isSelected={isSelected}
      onSelectRequest={onSelectRequest}
      testId="conversation-message"
      entryIndex={entryIndex}
    >
      {blocks !== null ? (
        <div className="space-y-2 p-3">
          {blocks.map((block, blockIndex) => (
            <BlockWithToolLink
              key={blockKey(block, blockIndex)}
              block={block}
              blockIndex={blockIndex}
              pairings={pairings}
            />
          ))}
        </div>
      ) : (
        <div className="p-3">
          {renderBlock(
            { type: "text", text: stringifyContent(entry.content) },
            { index: 0 },
          )}
        </div>
      )}
    </EntryShell>
  );
}

// ─── Assistant response row ───────────────────────────────────────────────

function AssistantResponseRow({
  entry,
  entryIndex,
  selectedRequestId,
  pairings,
  onSelectRequest,
}: {
  entry: Extract<TimelineEntry, { kind: "assistant_response" }>;
  entryIndex: number;
  selectedRequestId: string;
  pairings: ReturnType<typeof buildToolPairings>;
  onSelectRequest?: (requestId: string) => void;
}) {
  const isSelected = entry.producedByRequestId === selectedRequestId;
  return (
    <EntryShell
      role="assistant"
      introducedByRequestId={entry.producedByRequestId}
      isSelected={isSelected}
      onSelectRequest={onSelectRequest}
      testId="conversation-assistant-response"
      entryIndex={entryIndex}
      isAnchor={isSelected}
    >
      {entry.inFlight ? (
        <div
          data-testid="conversation-in-flight"
          className="px-3 py-2 font-mono text-xs text-neutral-500"
        >
          (streaming…)
        </div>
      ) : (
        <div className="space-y-2 p-3">
          {entry.content.map((block, blockIndex) => (
            <BlockWithToolLink
              key={blockKey(block, blockIndex)}
              block={block}
              blockIndex={blockIndex}
              pairings={pairings}
            />
          ))}
        </div>
      )}
    </EntryShell>
  );
}

// ─── Shared entry shell + tool-pair anchors ──────────────────────────────

function EntryShell({
  role,
  introducedByRequestId,
  isSelected,
  isAnchor = false,
  onSelectRequest,
  testId,
  entryIndex,
  children,
}: {
  role: string;
  introducedByRequestId: string;
  isSelected: boolean;
  isAnchor?: boolean;
  onSelectRequest?: (requestId: string) => void;
  testId: string;
  entryIndex: number;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-role={role}
      data-introduced-by={introducedByRequestId}
      data-selected={isSelected ? "true" : "false"}
      data-entry-index={entryIndex}
      data-selected-anchor={isAnchor && isSelected ? "true" : undefined}
      className={`rounded border bg-neutral-950 ${
        isSelected
          ? "border-l-4 border-l-cyan-500 border-y-neutral-800 border-r-neutral-800"
          : "border-neutral-800"
      }`}
    >
      <header className="flex items-center justify-between border-b border-neutral-900 px-3 py-2 text-xs">
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300">
          {role}
        </span>
        <RequestIdLink
          requestId={introducedByRequestId}
          onSelectRequest={onSelectRequest}
          className="text-[10px] text-neutral-500"
          testId="conversation-attribution-chip"
        />
      </header>
      <div>{children}</div>
    </section>
  );
}

// Wraps a block render with two pieces of conversation-only context:
//   - A scroll anchor (data-tool-use-id / data-tool-result-id) so the
//     paired-link buttons can `scrollIntoView` the matching block.
//   - A "→ result" / "← input" jump link when a pair exists.
// [LAW:single-enforcer] The block CONTENT still renders through
// renderBlock; this wrapper only adds conversation-level navigation.
function BlockWithToolLink({
  block,
  blockIndex,
  pairings,
}: {
  block: unknown;
  blockIndex: number;
  pairings: ReturnType<typeof buildToolPairings>;
}) {
  const rec = asRecord(block);
  const isToolUse = rec?.type === "tool_use" && typeof rec.id === "string";
  const isToolResult =
    rec?.type === "tool_result" && typeof rec.tool_use_id === "string";

  const toolUseId = isToolUse ? (rec.id as string) : null;
  const resultId = isToolResult ? (rec.tool_use_id as string) : null;
  const hasResultLink =
    toolUseId !== null && pairings.toolUseToResult.has(toolUseId);
  const hasUseLink =
    resultId !== null && pairings.toolResultToUse.has(resultId);

  return (
    <div
      data-tool-use-id={toolUseId ?? undefined}
      data-tool-result-id={resultId ?? undefined}
    >
      {renderBlock(block, { index: blockIndex })}
      {hasResultLink && toolUseId !== null ? (
        <ToolJumpLink
          attr="data-tool-result-id"
          value={toolUseId}
          label="→ result"
          testId="conversation-tool-use-jump"
        />
      ) : null}
      {hasUseLink && resultId !== null ? (
        <ToolJumpLink
          attr="data-tool-use-id"
          value={resultId}
          label="← input"
          testId="conversation-tool-result-jump"
        />
      ) : null}
    </div>
  );
}

// [LAW:single-enforcer] One place that decides "interactive vs static"
// for a request-id display. Renders as a `<button>` when a handler is
// provided (the chip selects the linked request); renders as a `<span>`
// when not (the chip is purely informational — no focus trap, no
// clickable-but-does-nothing footgun). Matches the pattern StopReasonChip
// uses for the same trade-off.
function RequestIdLink({
  requestId,
  onSelectRequest,
  className,
  testId,
}: {
  requestId: string;
  onSelectRequest?: (requestId: string) => void;
  className: string;
  testId: string;
}) {
  const short = requestId.slice(0, 8);
  if (onSelectRequest === undefined) {
    return (
      <span data-testid={testId} className={className}>
        {short}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelectRequest(requestId)}
      data-testid={testId}
      className={`${className} underline-offset-2 hover:underline`}
    >
      {short}
    </button>
  );
}

// [LAW:single-enforcer] Selector construction lives here. Callers pass
// the attribute name and value as separate strings; the value is
// CSS-escaped before being interpolated. This shape makes "the caller
// built the selector with an unescaped untrusted value" unrepresentable
// at the type level — there is no `target` parameter to misuse.
//
// [LAW:locality-or-seam] The jump scope is the timeline container that
// hosts THIS button, not the whole document. `closest()` keeps the
// lookup local to the rendering tree even when multiple Conversation
// tabs coexist in the document.
function ToolJumpLink({
  attr,
  value,
  label,
  testId,
}: {
  attr: string;
  value: string;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(event) => {
        const scope = event.currentTarget.closest(
          '[data-testid="conversation-timeline"]',
        );
        if (scope === null) return;
        // tool_use_id comes from untrusted Anthropic payloads — values
        // containing `]`, `"`, or escape characters would otherwise
        // break the selector or hit the wrong element. CSS.escape is
        // the supported sanitizer; the try/catch is a backstop for
        // engines (very old browsers, certain test environments) that
        // either lack CSS.escape or reject the selector.
        try {
          const selector = `[${attr}="${cssEscape(value)}"]`;
          const el = scope.querySelector(selector);
          if (
            el instanceof HTMLElement &&
            typeof el.scrollIntoView === "function"
          ) {
            el.scrollIntoView({ block: "nearest", behavior: "auto" });
          }
        } catch {
          // Malformed id → no-op. Clicking does nothing, but the UI
          // doesn't crash.
        }
      }}
      className="mt-1 ml-1 text-[10px] text-cyan-400 underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
}

// CSS.escape is in every Electron / modern browser; the fallback is
// defensive against very old test environments. We do the minimum
// escape (`"` → `\"`, `\` → `\\`) which is sufficient for the values
// in a `[attr="..."]` selector.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function msFromNs(ns: number): number {
  return Math.round(ns / 1_000_000);
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
