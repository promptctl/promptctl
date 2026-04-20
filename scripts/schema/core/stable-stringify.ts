// [LAW:dataflow-not-control-flow] Deterministic JSON emission. Same input, same bytes.
// Sorts object keys by codepoint at every depth; array order is preserved (arrays
// are ordered data). Supports a replacer for redacting/transforming values in place.

export function stableStringify(
  value: unknown,
  indent = 2,
): string {
  return JSON.stringify(sortKeys(value), null, indent) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}
