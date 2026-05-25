// [LAW:one-source-of-truth] PromptsPanel renders the bucketBySystemPrompt
// projection. The store owns selectedPromptHash; this component is a
// pure projection that calls onSelectHash to toggle it.
//
// [LAW:dataflow-not-control-flow] No conditional logic that varies
// behavior based on capture mode. The same panel, fed the same
// records, produces the same output for live and HAR-replay.
//
// [LAW:types-are-the-program] Every PromptBucket the panel iterates
// over has a non-null hash by construction (see promptBuckets.ts).
// The component never branches on "is this a real bucket?".

import { useMemo, useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import {
  bucketBySystemPrompt,
  fullPromptText,
  systemPreview,
  toolNames,
  type PromptBucket,
} from "./promptBuckets";
import { shortHash } from "./promptHash";

// Chars shown when a bucket card is collapsed. The full prompt is
// available on click — see BucketCard.
const COLLAPSED_PREVIEW_CHARS = 480;

interface PromptsPanelProps {
  requests: readonly RequestRecord[];
  selectedHash: string | null;
  onSelectHash: (hash: string) => void;
}

export function PromptsPanel({
  requests,
  selectedHash,
  onSelectHash,
}: PromptsPanelProps) {
  const buckets = useMemo(() => bucketBySystemPrompt(requests), [requests]);
  // Expansion is a per-card UI affordance, not a filter — keep it local
  // to the panel rather than promoting it to the store. Multiple cards
  // can be expanded simultaneously; the set is keyed by hash so a
  // bucket's expansion survives re-renders when requests stream in.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (buckets.length === 0) {
    return (
      <div
        data-testid="prompts-panel"
        className="border-b border-neutral-800 bg-neutral-950 px-4 py-6 text-xs text-neutral-500"
      >
        No system prompts captured yet. Requests without a system prompt
        don&apos;t appear here.
      </div>
    );
  }

  return (
    <div
      data-testid="prompts-panel"
      className="max-h-72 overflow-y-auto border-b border-neutral-800 bg-neutral-950 px-4 py-3"
    >
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
        <span>
          {buckets.length} distinct system prompt{buckets.length === 1 ? "" : "s"}
        </span>
        {selectedHash !== null && (
          <span className="font-mono text-neutral-400">
            filtering · #{shortHash(selectedHash)}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {buckets.map((bucket) => (
          <BucketCard
            key={bucket.hash}
            bucket={bucket}
            selected={selectedHash === bucket.hash}
            expanded={expanded.has(bucket.hash)}
            onSelect={() => onSelectHash(bucket.hash)}
            onToggleExpanded={() =>
              setExpanded((prev) => toggleSet(prev, bucket.hash))
            }
          />
        ))}
      </div>
    </div>
  );
}

function toggleSet(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function BucketCard({
  bucket,
  selected,
  expanded,
  onSelect,
  onToggleExpanded,
}: {
  bucket: PromptBucket;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
}) {
  const tools = toolNames(bucket.sampleTools);
  const visibleTools = tools.slice(0, 6);
  const extraTools = tools.length - visibleTools.length;
  return (
    <div
      data-testid="prompt-bucket-card"
      data-prompt-hash={bucket.hash}
      data-expanded={expanded ? "true" : "false"}
      className={`rounded border px-3 py-2 ${
        selected
          ? "border-cyan-500 bg-cyan-950/30"
          : "border-neutral-800 bg-neutral-900/50"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={onToggleExpanded}
            data-testid="prompt-bucket-hash"
            aria-expanded={expanded}
            aria-controls={`prompt-bucket-preview-${bucket.hash}`}
            aria-label={
              expanded
                ? `Collapse system prompt #${shortHash(bucket.hash)}`
                : `Open full system prompt #${shortHash(bucket.hash)}`
            }
            className="font-mono text-cyan-300 underline-offset-2 hover:underline"
            title={
              expanded
                ? `Collapse · systemPromptHash: ${bucket.hash}`
                : `Open full prompt · systemPromptHash: ${bucket.hash}`
            }
          >
            #{shortHash(bucket.hash)}
          </button>
          <span className="text-neutral-500">
            used by {bucket.count} request{bucket.count === 1 ? "" : "s"} ·{" "}
            {bucket.clientIds.length} client
            {bucket.clientIds.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          onClick={onSelect}
          data-testid="prompt-bucket-filter"
          className={`rounded px-2 py-0.5 text-[11px] ${
            selected
              ? "bg-cyan-700 text-white hover:bg-cyan-600"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          {selected ? "Clear filter" : "Filter list to this prompt"}
        </button>
      </div>
      {/* [LAW:dataflow-not-control-flow] Expanded-vs-collapsed is one
        prop driving one className path. The pre always renders; the
        text content and overflow behavior change with the data. */}
      <pre
        id={`prompt-bucket-preview-${bucket.hash}`}
        data-testid="prompt-bucket-preview"
        className={`mt-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-neutral-300 ${
          expanded ? "max-h-96 overflow-y-auto" : "max-h-32 overflow-hidden"
        }`}
      >
        {expanded
          ? fullPromptText(bucket.sampleSystem)
          : systemPreview(bucket.sampleSystem, COLLAPSED_PREVIEW_CHARS)}
      </pre>
      {tools.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
          <span className="text-neutral-500">tools:</span>
          {visibleTools.map((name) => (
            <span
              key={name}
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300"
            >
              {name}
            </span>
          ))}
          {extraTools > 0 && (
            <span className="text-neutral-500">+{extraTools}</span>
          )}
          {bucket.sampleToolsHash !== null && (
            <span
              className="ml-1 font-mono text-neutral-600"
              title={`toolsHash: ${bucket.sampleToolsHash}`}
            >
              #{shortHash(bucket.sampleToolsHash)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
