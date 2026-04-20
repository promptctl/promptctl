// [LAW:one-source-of-truth] Declared reference edges per provider. These encode
// the structural relationships that downstream code (session adapter, schema doc,
// API contract validators) depends on. The extractor verifies them against the
// corpus; orphan rate is surfaced in the schema artifact.
//
// Field paths are dotted with `[variantName]` for discriminated array items,
// e.g. `message.content[tool_result].tool_use_id`. The extractor resolves
// these paths against the raw records as it walks them.

import type { ReferenceEdge } from "./types";

export interface DeclaredEdge {
  /** Dotted field path on the "from" side. */
  from: string;
  /** Dotted field path on the "to" side. */
  to: string;
  /** Human explanation of the relationship. */
  note: string;
}

export const CLAUDE_EDGES: DeclaredEdge[] = [
  {
    from: "ClaudeLine.parentUuid",
    to: "ClaudeLine.uuid",
    note: "Message chain link — each line's parent is the prior line's uuid.",
  },
  {
    from: "ClaudeLine.sourceToolAssistantUUID",
    to: "ClaudeLine.uuid",
    note: "Tool-result line pointing at the assistant line that issued the tool_use.",
  },
  {
    from: "ClaudeLine.message.content[tool_result].tool_use_id",
    to: "ClaudeLine.message.content[tool_use].id",
    note:
      "Every tool_result block must reference a tool_use block issued earlier in the conversation.",
  },
  {
    from: "ClaudeLine.messageId",
    to: "ClaudeLine.uuid",
    note:
      "Sidecar records (file-history-snapshot, pr-link, etc.) reference the assistant uuid they relate to.",
  },
];

export const GEMINI_EDGES: DeclaredEdge[] = [
  // Gemini sessions are single-file; references within are minimal. Message
  // ids are local to a session so no declared cross-record edges. Add as
  // discovered.
];

/** Index of observed values keyed by field path — populated during corpus scan. */
export type ValueIndex = Map<string, Set<string>>;

/** Add a single observed (fieldPath → value) pair to the index. */
export function indexValue(
  idx: ValueIndex,
  fieldPath: string,
  value: string,
): void {
  let set = idx.get(fieldPath);
  if (!set) {
    set = new Set();
    idx.set(fieldPath, set);
  }
  set.add(value);
}

/** Add every observed value at the `from` path, so we can compute resolution. */
export function verifyDeclaredEdges(
  edges: DeclaredEdge[],
  fromValues: Map<string, string[]>,
  toValueIndex: ValueIndex,
): ReferenceEdge[] {
  const results: ReferenceEdge[] = [];
  for (const edge of edges) {
    const froms = fromValues.get(edge.from) ?? [];
    const tos = toValueIndex.get(edge.to) ?? new Set<string>();
    let resolved = 0;
    for (const v of froms) {
      if (tos.has(v)) resolved++;
    }
    const fromCount = froms.length;
    const orphanRate =
      fromCount === 0 ? 0 : Math.round(((fromCount - resolved) / fromCount) * 10_000) / 10_000;
    results.push({
      from: edge.from,
      to: edge.to,
      fromCount,
      resolvedCount: resolved,
      orphanRate,
      source: "declared",
      verified: true,
    });
  }
  return results;
}

/**
 * Suggest reference edges automatically from value overlap. For every pair of
 * string-valued field paths where both have cardinality ≥ minCardinality and
 * the fraction of A's values present in B is ≥ overlapThreshold, emit a
 * suggestion. Declared edges are excluded.
 */
export function suggestEdges(
  valueIndex: ValueIndex,
  declared: DeclaredEdge[],
  opts: { minCardinality?: number; overlapThreshold?: number } = {},
): ReferenceEdge[] {
  const minCardinality = opts.minCardinality ?? 50;
  const overlapThreshold = opts.overlapThreshold ?? 0.95;
  const declaredKeys = new Set(declared.map((e) => `${e.from}->${e.to}`));

  const paths = [...valueIndex.keys()].filter(
    (p) => (valueIndex.get(p)?.size ?? 0) >= minCardinality,
  );
  paths.sort();

  const suggestions: ReferenceEdge[] = [];
  for (const from of paths) {
    const fromSet = valueIndex.get(from)!;
    for (const to of paths) {
      if (from === to) continue;
      if (declaredKeys.has(`${from}->${to}`)) continue;
      const toSet = valueIndex.get(to)!;
      let resolved = 0;
      for (const v of fromSet) if (toSet.has(v)) resolved++;
      const overlap = resolved / fromSet.size;
      if (overlap >= overlapThreshold) {
        const orphanRate = Math.round((1 - overlap) * 10_000) / 10_000;
        suggestions.push({
          from,
          to,
          fromCount: fromSet.size,
          resolvedCount: resolved,
          orphanRate,
          source: "suggested",
          verified: false,
        });
      }
    }
  }
  suggestions.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });
  return suggestions;
}
