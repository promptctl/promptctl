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
import type { SessionSaveResult } from "../../shared/types";
import { useSessionStore } from "../store/sessions";

// [LAW:dataflow-not-control-flow] Per-kind display data — adding a new
// StepKind = one entry here. The UI never branches on kind elsewhere.
const STEP_KIND_LABEL: Record<string, { label: string; color: string }> = {
  "strip-thinking": {
    label: "Strip thinking",
    color: "bg-purple-500/20 text-purple-300",
  },
  "remove-messages": {
    label: "Remove",
    color: "bg-red-500/20 text-red-300",
  },
};

function StepKindBadge({ kind }: { kind: string }) {
  const info = STEP_KIND_LABEL[kind] ?? {
    label: kind,
    color: "bg-neutral-700 text-neutral-300",
  };
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
  // [LAW:dataflow-not-control-flow] Single derived value; UI just renders it.
  const totalTargets = useMemo(
    () => pipeline.steps.reduce((n, s) => n + s.targets.length, 0),
    [pipeline.steps],
  );

  const handleApply = async () => {
    const result = await applyPipeline();
    onApplied(result);
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
            onClick={handleApply}
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

// Derived data: which step kinds target a given source-message index. Used
// by MessageRow to render per-row pipeline-effect badges.
// [LAW:dataflow-not-control-flow] Pure projection of the pipeline; callers
// pass it in instead of subscribing to the store from inside the row (rows
// re-render constantly; subscribing in each row would cost more than reading
// once at the parent and passing the result down).
export function pipelineEffectsForIndex(
  steps: { kind: string; targets: number[] }[],
  index: number,
): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.targets.includes(index)) out.push(step.kind);
  }
  return out;
}

export function PipelineEffectBadges({ kinds }: { kinds: string[] }) {
  if (kinds.length === 0) return null;
  return (
    <>
      {kinds.map((kind, i) => {
        const info = STEP_KIND_LABEL[kind] ?? {
          label: kind,
          color: "bg-neutral-700 text-neutral-300",
        };
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
