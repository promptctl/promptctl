// [LAW:one-source-of-truth] PipelinePanel reads directly from useSessionStore.
// No props beyond an onApplied callback that lets the host surface the result
// dialog (validation / live-tail) through its existing dispatch.
//
// Two stacked sections:
//   - Analyzers: for each registered analyzer, a row showing its summary plus
//     a list of recommendations. Each recommendation can be added to the
//     pipeline as a step (the analyzer is the proposer; the user is the
//     accepter — see [LAW:one-type-per-behavior]).
//   - Pipeline: the ordered list of accepted steps with a removal button per
//     step and the primary Apply action.
//
// Slice 1 keeps it minimal — no reorder UI, no step config editor. Both land
// in slice 4.
import { useMemo, useState } from "react";
import type {
  SessionSaveResult,
  Step,
  StepKind,
} from "../../shared/types";
import { useSessionStore } from "../store/sessions";

// [LAW:types-are-the-program] Record<StepKind, …> makes UI display data
// exhaustive at compile time. Adding a new StepKind without an entry here
// fails type-check, mirroring how runPipeline's OPS table forces a new
// kind to have a backing operation. No fallback default-case branch.
const STEP_KIND_LABEL: Record<StepKind, { label: string; color: string }> = {
  "strip-thinking": {
    label: "Strip thinking",
    color: "bg-purple-500/20 text-purple-300",
  },
  "remove-messages": {
    label: "Remove",
    color: "bg-red-500/20 text-red-300",
  },
};

function StepKindBadge({ kind }: { kind: StepKind }) {
  const info = STEP_KIND_LABEL[kind];
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${info.color}`}>
      {info.label}
    </span>
  );
}

export function PipelinePanel({
  onApplied,
}: {
  onApplied: (result: SessionSaveResult) => void;
}) {
  const {
    analyzerMetadata,
    analyzerResults,
    analyzerRunning,
    pipeline,
    applying,
    runAnalyzer,
    addStep,
    removeStep,
    clearPipeline,
    applyPipeline,
  } = useSessionStore();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Total target count across all steps — shown next to the Apply button.
  // Dedupe per step (matches buildPipelineEffectMap) so duplicate indices
  // in a step's targets don't inflate the count beyond what the ops will
  // actually act on.
  const totalTargets = useMemo(
    () => pipeline.steps.reduce((n, s) => n + new Set(s.targets).size, 0),
    [pipeline.steps],
  );

  // applyPipeline can throw (the store rethrows IPC invoke errors so the
  // try/finally around `applying` can always reset). Catch here to keep
  // the Apply button from leaving an unhandled rejection on the page.
  const handleApply = async () => {
    try {
      const result = await applyPipeline();
      onApplied(result);
    } catch (err) {
      console.error("applyPipeline failed:", err);
    }
  };

  if (analyzerMetadata.length === 0 && pipeline.steps.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border border-purple-900/40 bg-purple-950/10 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-200">
          Pipeline
          {pipeline.steps.length > 0 && (
            <span className="ml-2 rounded bg-purple-600/30 px-1.5 py-0.5 text-xs text-purple-200">
              {pipeline.steps.length} step
              {pipeline.steps.length === 1 ? "" : "s"} ·{" "}
              {totalTargets} target{totalTargets === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {pipeline.steps.length > 0 && (
            <button
              onClick={clearPipeline}
              className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => void handleApply()}
            disabled={pipeline.steps.length === 0 || applying}
            className="rounded bg-purple-600/80 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-purple-600 disabled:opacity-30"
          >
            {applying ? "Applying..." : "Apply"}
          </button>
        </div>
      </div>

      {/* Analyzers */}
      {analyzerMetadata.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Analyzers
          </div>
          {analyzerMetadata.map((meta) => {
            const result = analyzerResults[meta.id];
            const running = analyzerRunning.has(meta.id);
            const recs = result?.recommendations ?? [];
            const isExpanded = expanded.has(meta.id);
            return (
              <div
                key={meta.id}
                className="rounded border border-neutral-800 bg-neutral-900/50"
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    onClick={() => toggleExpand(meta.id)}
                    className="text-neutral-500 hover:text-neutral-200"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-200">
                        {meta.name}
                      </span>
                      {running ? (
                        <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-xs text-neutral-300">
                          running...
                        </span>
                      ) : result ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            recs.length > 0
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-emerald-500/20 text-emerald-300"
                          }`}
                        >
                          {result.summary ??
                            (recs.length === 0 ? "Clean" : `${recs.length}`)}
                        </span>
                      ) : null}
                    </div>
                    {isExpanded && (
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {meta.description}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => void runAnalyzer(meta.id)}
                    disabled={running}
                    className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    title="Re-run analyzer"
                  >
                    Run
                  </button>
                </div>
                {isExpanded && recs.length > 0 && (
                  <div className="space-y-1 border-t border-neutral-800 px-2 py-1.5">
                    {recs.map((rec, i) => (
                      <div
                        key={`${meta.id}:${i}`}
                        className="flex items-start gap-2 text-xs"
                      >
                        <StepKindBadge kind={rec.step.kind} />
                        <span className="text-neutral-500">
                          {rec.step.targets.length} target
                          {rec.step.targets.length === 1 ? "" : "s"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-neutral-400">
                          {rec.step.rationale ?? ""}
                        </span>
                        <button
                          onClick={() => addStep(rec.step)}
                          className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 hover:bg-neutral-700"
                        >
                          Add to pipeline
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pipeline steps */}
      {pipeline.steps.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Steps
          </div>
          <div className="space-y-1">
            {pipeline.steps.map((step, idx) => (
              <div
                key={step.id}
                className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/50 px-2 py-1.5 text-xs"
              >
                <span className="w-5 shrink-0 text-neutral-600">
                  {idx + 1}.
                </span>
                <StepKindBadge kind={step.kind} />
                <span className="text-neutral-500">
                  {step.targets.length} target
                  {step.targets.length === 1 ? "" : "s"}
                </span>
                <span className="text-neutral-600">
                  from {step.source}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-400">
                  {step.rationale ?? ""}
                </span>
                <button
                  onClick={() => removeStep(step.id)}
                  className="shrink-0 rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Remove step from pipeline"
                  aria-label="Remove step from pipeline"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Derived data: an index→kinds Map covering every message a pipeline step
// targets. The host computes this once per pipeline change (useMemo) and
// passes the Map down; each MessageRow does an O(1) Map.get(index) lookup
// instead of scanning every step's targets array on every render.
//
// [LAW:dataflow-not-control-flow] Variability lives in the precomputed Map
// — rows don't know which steps exist, they just read what they need to
// render. With many steps and large sessions, the old "scan steps for each
// row" shape was O(messages × steps × targets); this is O(steps × targets)
// once + O(1) per row.
export function buildPipelineEffectMap(
  steps: Step[],
): Map<number, StepKind[]> {
  const map = new Map<number, StepKind[]>();
  for (const step of steps) {
    // Dedupe targets within a step — if a user/analyzer ever produces
    // duplicate indices, the ops dedupe via UUID Set, so the UI must
    // match. One step contributes at most one badge per message index.
    const uniqueTargets = new Set(step.targets);
    for (const idx of uniqueTargets) {
      const existing = map.get(idx);
      if (existing) existing.push(step.kind);
      else map.set(idx, [step.kind]);
    }
  }
  return map;
}

export function PipelineEffectBadges({ kinds }: { kinds: StepKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <>
      {kinds.map((kind, i) => {
        const info = STEP_KIND_LABEL[kind];
        return (
          <span
            key={`${kind}:${i}`}
            className={`rounded px-1 py-0.5 text-xs font-medium ${info.color}`}
            title={`Pipeline will: ${info.label.toLowerCase()}`}
          >
            ⚙ {info.label}
          </span>
        );
      })}
    </>
  );
}
