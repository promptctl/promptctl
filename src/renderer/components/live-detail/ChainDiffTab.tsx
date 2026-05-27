// [LAW:dataflow-not-control-flow] One render path for every chain shape.
// A chain of length 1, a chain where the prompt never changes, a chain
// where tools change every step — they all flow through buildSystemRuns
// + buildToolsRuns and render two version lists with diff cards between
// consecutive distinct versions. Variability lives in the run arrays.
//
// [LAW:single-enforcer] All prompt/tools diff logic comes from chainDiff;
// this file is a pure renderer. The diff functions (diffSystem, diffTools)
// are the single source of "what changed between two versions" — adding
// a third "Chain X-ray" surface later means consuming the same outputs,
// never duplicating the math.
//
// [LAW:one-source-of-truth] Versions and diffs are derived once per chain
// via useMemo keyed on the chain's request ids + bodies hash. No parallel
// state for "selected version" — the selected request id is supplied by
// the parent (matches what the chain strip and conversation tab already do).

import { useMemo, useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import {
  buildSystemRuns,
  buildToolsRuns,
  diffSystem,
  diffTools,
  type ChainVersionRun,
  type SystemDiffChunk,
  type ToolsDiff,
} from "./chainDiff";
import { JsonlLineView } from "../jsonl-view/JsonlLineView";
import { fullPromptText, toolNames } from "./promptBuckets";
import { shortHash } from "./promptHash";
import { HighlightedText } from "./blocks";

export function ChainDiffTab({
  chain,
  selectedRequestId,
  highlightSubstring = "",
  onSelectRequest,
}: {
  chain: RequestRecord[] | null;
  selectedRequestId: string;
  highlightSubstring?: string;
  onSelectRequest?: (requestId: string) => void;
}) {
  const safeChain = chain ?? [];
  // [LAW:types-are-the-program] The memo key encodes every dimension the
  // projection depends on: chain shape (request ids in order) and each
  // request's system/tools content (we use their hashes via the body
  // serialization). In practice requestBody is replaced atomically by
  // the proxy when the request is parsed, so the array of ids is a
  // sufficient key — but we include the body's `system`/`tools` length
  // signatures as cheap change-detection in case bodies are patched
  // in place.
  const memoKey = safeChain
    .map((r) => `${r.requestId}:${systemSig(r)}:${toolsSig(r)}`)
    .join("|");
  const systemRuns = useMemo(() => buildSystemRuns(safeChain), [memoKey]);
  const toolsRuns = useMemo(() => buildToolsRuns(safeChain), [memoKey]);

  if (safeChain.length === 0) {
    return (
      <div
        className="p-4 text-sm text-neutral-500"
        data-testid="chain-diff-empty"
      >
        No chain available — open a request that has a parent or a
        continuation to see prompt evolution.
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4" data-testid="chain-diff-tab">
      <Section
        title="System prompt versions"
        runs={systemRuns}
        selectedRequestId={selectedRequestId}
        highlightSubstring={highlightSubstring}
        onSelectRequest={onSelectRequest}
        renderBody={(run) => (
          <SystemRunBody
            value={run.value}
            highlightSubstring={highlightSubstring}
          />
        )}
        renderDiff={(prev, current) => (
          <SystemDiffView
            chunks={diffSystem(prev.value, current.value)}
            highlightSubstring={highlightSubstring}
          />
        )}
        emptyHash="(no prompt)"
        testIdPrefix="chain-diff-system"
      />
      <Section
        title="Tools array versions"
        runs={toolsRuns}
        selectedRequestId={selectedRequestId}
        highlightSubstring={highlightSubstring}
        onSelectRequest={onSelectRequest}
        renderBody={(run) => <ToolsRunBody value={run.value} />}
        renderDiff={(prev, current) => (
          <ToolsDiffView diff={diffTools(prev.value, current.value)} />
        )}
        emptyHash="(no tools)"
        testIdPrefix="chain-diff-tools"
      />
    </div>
  );
}

// ─── Section (system OR tools) ────────────────────────────────────────────

function Section({
  title,
  runs,
  selectedRequestId,
  highlightSubstring: _highlight,
  onSelectRequest,
  renderBody,
  renderDiff,
  emptyHash,
  testIdPrefix,
}: {
  title: string;
  runs: ChainVersionRun<unknown>[];
  selectedRequestId: string;
  highlightSubstring: string;
  onSelectRequest?: (requestId: string) => void;
  renderBody: (run: ChainVersionRun<unknown>) => React.ReactNode;
  renderDiff: (
    prev: ChainVersionRun<unknown>,
    current: ChainVersionRun<unknown>,
  ) => React.ReactNode;
  emptyHash: string;
  testIdPrefix: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return (
    <section data-testid={testIdPrefix}>
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {title}
        </h2>
        <span className="text-[10px] text-neutral-500">
          {runs.length === 1
            ? "no changes across chain"
            : `${runs.length - 1} change${runs.length - 1 === 1 ? "" : "s"} across chain`}
        </span>
      </header>
      <div className="space-y-2">
        {runs.map((run, index) => {
          const key = runKey(run, index);
          const isExpanded = expanded.has(key);
          const isSelected = run.requestIds.includes(selectedRequestId);
          const prior = index === 0 ? null : runs[index - 1];
          return (
            <RunCard
              key={key}
              run={run}
              index={index}
              isExpanded={isExpanded}
              isSelected={isSelected}
              onToggleExpanded={() =>
                setExpanded((prev) => toggleSet(prev, key))
              }
              onSelectRequest={onSelectRequest}
              renderBody={renderBody}
              renderDiff={renderDiff}
              prior={prior}
              emptyHash={emptyHash}
              testIdPrefix={testIdPrefix}
            />
          );
        })}
      </div>
    </section>
  );
}

function RunCard({
  run,
  index,
  isExpanded,
  isSelected,
  onToggleExpanded,
  onSelectRequest,
  renderBody,
  renderDiff,
  prior,
  emptyHash,
  testIdPrefix,
}: {
  run: ChainVersionRun<unknown>;
  index: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpanded: () => void;
  onSelectRequest?: (requestId: string) => void;
  renderBody: (run: ChainVersionRun<unknown>) => React.ReactNode;
  renderDiff: (
    prev: ChainVersionRun<unknown>,
    current: ChainVersionRun<unknown>,
  ) => React.ReactNode;
  prior: ChainVersionRun<unknown> | null;
  emptyHash: string;
  testIdPrefix: string;
}) {
  const hashLabel = run.hash === null ? emptyHash : `#${shortHash(run.hash)}`;
  const usageCount = run.requestIds.length;
  return (
    <article
      data-testid={`${testIdPrefix}-card`}
      data-version-index={index}
      data-hash={run.hash ?? ""}
      data-selected={isSelected ? "true" : "false"}
      className={`rounded border bg-neutral-950 ${
        isSelected
          ? "border-l-4 border-l-cyan-500 border-y-neutral-700 border-r-neutral-700"
          : "border-neutral-800"
      }`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-900 px-3 py-2 text-[11px]">
        <button
          type="button"
          data-testid={`${testIdPrefix}-toggle`}
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          className="font-mono text-cyan-300 underline-offset-2 hover:underline"
          title={
            run.hash === null
              ? "No content on this run"
              : `Open full content · hash: ${run.hash}`
          }
        >
          v{index + 1} {hashLabel}
        </button>
        <span className="text-neutral-500">
          used by {usageCount} request{usageCount === 1 ? "" : "s"}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {run.requestIds.map((requestId) => (
            <RequestChip
              key={requestId}
              requestId={requestId}
              isSelected={requestId === run.firstIntroducedAt}
              onSelectRequest={onSelectRequest}
            />
          ))}
        </span>
      </header>
      {/* [LAW:dataflow-not-control-flow] Diff slot always renders for non-first
        runs; the diff data decides whether anything visible is produced. */}
      {prior !== null ? (
        <div
          data-testid={`${testIdPrefix}-diff`}
          className="border-b border-neutral-900 px-3 py-2"
        >
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
            diff vs v{index} {prior.hash === null ? emptyHash : `#${shortHash(prior.hash)}`}
          </div>
          {renderDiff(prior, run)}
        </div>
      ) : null}
      {isExpanded ? (
        <div
          data-testid={`${testIdPrefix}-body`}
          className="px-3 py-2"
        >
          {renderBody(run)}
        </div>
      ) : null}
    </article>
  );
}

// ─── System body + diff ───────────────────────────────────────────────────

function SystemRunBody({
  value,
  highlightSubstring,
}: {
  value: unknown;
  highlightSubstring: string;
}) {
  if (value === null) {
    return (
      <div className="text-[11px] italic text-neutral-500">
        No system prompt on this run.
      </div>
    );
  }
  const text = fullPromptText(value);
  return (
    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-neutral-200">
      <HighlightedText text={text} query={highlightSubstring} />
    </pre>
  );
}

function SystemDiffView({
  chunks,
  highlightSubstring,
}: {
  chunks: SystemDiffChunk[];
  highlightSubstring: string;
}) {
  const hasChange = chunks.some((c) => c.kind !== "unchanged");
  if (!hasChange) {
    return (
      <div
        data-testid="chain-diff-system-unchanged"
        className="text-[11px] italic text-neutral-500"
      >
        No textual change — content equivalent.
      </div>
    );
  }
  return (
    <div className="space-y-0.5 font-mono text-[11px] leading-snug">
      {chunks.map((chunk, index) => (
        <DiffChunkLine
          key={index}
          chunk={chunk}
          highlightSubstring={highlightSubstring}
        />
      ))}
    </div>
  );
}

function DiffChunkLine({
  chunk,
  highlightSubstring,
}: {
  chunk: SystemDiffChunk;
  highlightSubstring: string;
}) {
  // `diff` library emits one Change per contiguous run; each `value`
  // may span multiple lines and ends with a newline. We split so each
  // visible row carries its own +/-/(space) prefix.
  const lines = chunk.value.split("\n");
  // diff appends an empty trailing entry for the final \n — drop it so
  // we don't render a blank row per chunk.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const className =
    chunk.kind === "added"
      ? "bg-green-950/40 text-green-200"
      : chunk.kind === "removed"
        ? "bg-red-950/40 text-red-200"
        : "text-neutral-400";
  const prefix = chunk.kind === "added" ? "+" : chunk.kind === "removed" ? "-" : " ";
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          data-testid={`chain-diff-system-line-${chunk.kind}`}
          className={`whitespace-pre-wrap break-words px-2 ${className}`}
        >
          <span className="mr-2 select-none text-neutral-500">{prefix}</span>
          <HighlightedText text={line} query={highlightSubstring} />
        </div>
      ))}
    </>
  );
}

// ─── Tools body + diff ────────────────────────────────────────────────────

function ToolsRunBody({ value }: { value: unknown }) {
  if (value === null) {
    return (
      <div className="text-[11px] italic text-neutral-500">
        No tools on this run.
      </div>
    );
  }
  const names = toolNames(value as unknown[]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {names.length === 0 ? (
          <span className="text-neutral-500">(no named tools)</span>
        ) : (
          names.map((name) => (
            <span
              key={name}
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200"
            >
              {name}
            </span>
          ))
        )}
      </div>
      <JsonlLineView raw={value} />
    </div>
  );
}

function ToolsDiffView({ diff }: { diff: ToolsDiff }) {
  const empty =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0;
  if (empty) {
    return (
      <div
        data-testid="chain-diff-tools-unchanged"
        className="text-[11px] italic text-neutral-500"
      >
        No structural change — same tools, same shapes.
      </div>
    );
  }
  return (
    <div className="space-y-2 text-[11px]">
      {diff.added.length > 0 && (
        <ToolGroup
          label="added"
          tone="added"
          tools={diff.added.map((t) => ({ name: t.name, value: t.value }))}
          testId="chain-diff-tools-added"
        />
      )}
      {diff.removed.length > 0 && (
        <ToolGroup
          label="removed"
          tone="removed"
          tools={diff.removed.map((t) => ({ name: t.name, value: t.value }))}
          testId="chain-diff-tools-removed"
        />
      )}
      {diff.changed.length > 0 && (
        <div data-testid="chain-diff-tools-changed">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-400">
            changed
          </div>
          <div className="space-y-1">
            {diff.changed.map((c) => (
              <div
                key={c.name}
                className="rounded border border-amber-800/60 bg-amber-950/20 p-2"
              >
                <div className="mb-1 font-mono text-amber-200">{c.name}</div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div>
                    <div className="text-[10px] text-red-300">before</div>
                    <JsonlLineView raw={c.from} />
                  </div>
                  <div>
                    <div className="text-[10px] text-green-300">after</div>
                    <JsonlLineView raw={c.to} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolGroup({
  label,
  tone,
  tools,
  testId,
}: {
  label: string;
  tone: "added" | "removed";
  tools: Array<{ name: string; value: unknown }>;
  testId: string;
}) {
  const headerClass =
    tone === "added" ? "text-green-300" : "text-red-300";
  const cardClass =
    tone === "added"
      ? "border-green-800/60 bg-green-950/20"
      : "border-red-800/60 bg-red-950/20";
  return (
    <div data-testid={testId}>
      <div className={`mb-1 text-[10px] uppercase tracking-wide ${headerClass}`}>
        {label}
      </div>
      <div className="space-y-1">
        {tools.map((t) => (
          <div key={t.name} className={`rounded border p-2 ${cardClass}`}>
            <div className="mb-1 font-mono text-neutral-200">{t.name}</div>
            <JsonlLineView raw={t.value} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Shared chip ─────────────────────────────────────────────────────────

function RequestChip({
  requestId,
  isSelected,
  onSelectRequest,
}: {
  requestId: string;
  isSelected: boolean;
  onSelectRequest?: (requestId: string) => void;
}) {
  const short = requestId.slice(0, 6);
  const baseClass =
    "rounded px-1.5 py-0.5 font-mono text-[10px] " +
    (isSelected
      ? "bg-cyan-900 text-cyan-100"
      : "bg-neutral-800 text-neutral-400");
  if (onSelectRequest === undefined) {
    return (
      <span data-testid="chain-diff-request-chip" className={baseClass}>
        {short}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="chain-diff-request-chip"
      onClick={() => onSelectRequest(requestId)}
      className={`${baseClass} hover:brightness-125`}
    >
      {short}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toggleSet(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function runKey(run: ChainVersionRun<unknown>, index: number): string {
  // Two adjacent runs cannot share both index and hash, but a chain like
  // AABA produces two runs with the same hash; the index disambiguates.
  return `${index}:${run.hash ?? "null"}`;
}

function systemSig(record: RequestRecord): string {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return "x";
  const s = (body as { system?: unknown }).system;
  if (typeof s === "string") return `s${s.length}`;
  if (Array.isArray(s)) return `a${s.length}`;
  return "n";
}

function toolsSig(record: RequestRecord): string {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return "x";
  const t = (body as { tools?: unknown }).tools;
  if (Array.isArray(t)) return `t${t.length}`;
  return "n";
}
