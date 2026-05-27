// [LAW:one-source-of-truth] Single definition of "source-message logical index
// → stable line identity (uuid)." Every pipeline op uses this to resolve a
// Step's source-relative targets against the running content, so step order
// can shift without breaking targets.
//
// Why uuid: it's the only identity Claude Code lines carry that survives
// transformations of the line list. Logical indices drift when previous steps
// remove lines; physical indices drift when blank lines are added/removed.
// uuid is invariant.
import { isVisibleMessage } from "../claude/adapter";
import type { ClaudeLine } from "../claude/types";

export function buildSourceIndexToUuid(source: string): Map<number, string> {
  const map = new Map<number, string>();
  let logicalIndex = -1;
  for (const raw of source.split("\n")) {
    if (!raw.trim()) continue;
    let line: ClaudeLine;
    try {
      line = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue;
    }
    if (!isVisibleMessage(line)) continue;
    logicalIndex++;
    if (typeof line.uuid === "string") map.set(logicalIndex, line.uuid);
  }
  return map;
}

// Variant that takes a precomputed source-index map. Ops receive the
// map from runPipeline (built once per pipeline run) and use this to
// resolve their targets without re-parsing the source content.
export function targetUuidsFromIndex(
  sourceIndex: Map<number, string>,
  targets: number[],
): Set<string> {
  const out = new Set<string>();
  for (const idx of targets) {
    const uuid = sourceIndex.get(idx);
    if (typeof uuid === "string") out.add(uuid);
  }
  return out;
}
