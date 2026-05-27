// [LAW:dataflow-not-control-flow] One loop dispatches on step.kind through
// the OPS lookup. Adding a new operation = new entry in StepKind + new entry
// here. There is no per-source branching, no special case for "where did
// this step come from."
//
// [LAW:single-enforcer] All pipeline application goes through this function.
// The editor coordinator calls it; the IPC handler calls the coordinator;
// nothing else writes pipeline-produced content.
//
// [LAW:types-are-the-program] OPS is typed Record<StepKind, Operation>, so
// the type system requires every StepKind to have an op. A new kind without
// an op is a compile error here, not a runtime "unknown step" guard inside
// the body.
import type { Pipeline, Step, StepKind } from "../../../shared/types";
import { stripThinking } from "./ops/strip-thinking";
import { removeMessages } from "./ops/remove-messages";
import { buildSourceIndexToUuid } from "./source-index";

// Each op receives a precomputed source-index → uuid map. Building it
// once per pipeline run (instead of per-step) keeps an N-step pipeline
// from re-parsing the entire source content N times — JSON.parse on
// long sessions dominates op-runtime, and this map is identical for
// every step in the same pipeline run.
export type Operation = (
  content: string,
  step: Step,
  sourceIndex: Map<number, string>,
) => string;

const OPS: Record<StepKind, Operation> = {
  "strip-thinking": stripThinking,
  "remove-messages": removeMessages,
};

export function runPipeline(content: string, pipeline: Pipeline): string {
  // [LAW:one-source-of-truth] Source-relative targets resolve against the
  // INITIAL content's index→uuid map. Step ordering then doesn't shift
  // targets — uuids are stable across removals/strips on the running
  // content.
  const sourceIndex = buildSourceIndexToUuid(content);
  let current = content;
  for (const step of pipeline.steps) {
    current = OPS[step.kind](current, step, sourceIndex);
  }
  return current;
}
