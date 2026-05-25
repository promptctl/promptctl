// [LAW:single-enforcer] Filter predicate composition lives here and is
// consumed only by visibleRequests in the proxy store. No other path
// filters the request list by these dimensions.
//
// [LAW:one-type-per-behavior] Every filter category — model, status,
// tool-use, error, size — is a Set<V> whose empty state means "any".
// One predicate shape (`set.size === 0 || set.has(extract(r))`) covers
// every category, so the composer is `.every()` over the categories.
// No tri-state sentinels, no per-category branches.
//
// [LAW:dataflow-not-control-flow] Each extractor runs unconditionally
// against every record. The Set state decides whether its value
// matches; control flow is identical for in-flight, streaming,
// complete, and errored records.

import type { AnthropicMessage, RequestRecord } from "../../../shared/proxy-events";

export type ModelValue = string;
export type StatusValue = "success" | "error" | "pending";
export type ToolUseValue = "yes" | "no";
export type ErrorValue = "yes" | "no";
export type SizeBucketValue = "small" | "medium" | "large";

// Size thresholds (design §7.3). Computed against the JSON-stringified
// request body length — a directional measure that matches what a user
// reads in the Request tab. Records without a body fall into "small".
const SIZE_MEDIUM_BYTES = 4 * 1024;
const SIZE_LARGE_BYTES = 64 * 1024;

export interface RequestFilters {
  models: Set<ModelValue>;
  statuses: Set<StatusValue>;
  toolUse: Set<ToolUseValue>;
  errors: Set<ErrorValue>;
  sizeBuckets: Set<SizeBucketValue>;
}

export function emptyFilters(): RequestFilters {
  return {
    models: new Set(),
    statuses: new Set(),
    toolUse: new Set(),
    errors: new Set(),
    sizeBuckets: new Set(),
  };
}

export function filtersAreEmpty(filters: RequestFilters): boolean {
  return (
    filters.models.size === 0 &&
    filters.statuses.size === 0 &&
    filters.toolUse.size === 0 &&
    filters.errors.size === 0 &&
    filters.sizeBuckets.size === 0
  );
}

export function modelOf(record: RequestRecord): ModelValue | null {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return null;
  const model = (body as Record<string, unknown>).model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

export function statusOf(record: RequestRecord): StatusValue {
  // Errored state and explicit proxy error both count as error,
  // regardless of HTTP status. A 4xx/5xx without an error string still
  // counts as error so the chip catches upstream failures.
  if (record.state === "errored" || record.error !== null) return "error";
  if (record.status !== null && record.status >= 400) return "error";
  if (record.state === "complete") return "success";
  return "pending";
}

export function hasToolUseOf(record: RequestRecord): ToolUseValue {
  const blocks = record.assembledResponse?.content;
  if (!Array.isArray(blocks)) return "no";
  return blocks.some((block) => block.type === "tool_use") ? "yes" : "no";
}

export function isErrorOf(record: RequestRecord): ErrorValue {
  return statusOf(record) === "error" ? "yes" : "no";
}

export function sizeBucketOf(record: RequestRecord): SizeBucketValue {
  // JSON-stringified length is the directional measure. Falls back to
  // 0 (→ small) when the body hasn't streamed in yet — same shape as a
  // genuinely empty request, which is the truthful answer at that
  // moment.
  const body = record.requestBody;
  const bytes = body === null || body === undefined ? 0 : JSON.stringify(body).length;
  if (bytes >= SIZE_LARGE_BYTES) return "large";
  if (bytes >= SIZE_MEDIUM_BYTES) return "medium";
  return "small";
}

// [LAW:single-enforcer] The extractor table is the only place that
// maps a category to its per-record value. The chip UI reads from the
// same table to populate its dropdown options from observed records.
export const EXTRACTORS = {
  models: modelOf,
  statuses: statusOf,
  toolUse: hasToolUseOf,
  errors: isErrorOf,
  sizeBuckets: sizeBucketOf,
} as const;

export type FilterKey = keyof RequestFilters;

export function passesFilters(
  record: RequestRecord,
  filters: RequestFilters,
): boolean {
  // [LAW:dataflow-not-control-flow] Every call site invokes the same
  // `matches` shape; the *data* (Set size) decides whether the
  // extractor runs. Lazy invocation matters because `sizeBucketOf`
  // pays a JSON.stringify per record — when the sizeBuckets filter
  // is empty (the common case), we skip that cost without changing
  // the code path.
  return (
    matches(filters.models, record, EXTRACTORS.models) &&
    matches(filters.statuses, record, EXTRACTORS.statuses) &&
    matches(filters.toolUse, record, EXTRACTORS.toolUse) &&
    matches(filters.errors, record, EXTRACTORS.errors) &&
    matches(filters.sizeBuckets, record, EXTRACTORS.sizeBuckets)
  );
}

function matches<V>(
  selected: Set<V>,
  record: RequestRecord,
  extract: (r: RequestRecord) => V | null,
): boolean {
  // Empty set is the no-op identity for AND composition — and we
  // never invoke the extractor when there is no constraint to check
  // against. A record whose extractor returned null can never match
  // a non-empty set — there is no value to ask the set about.
  if (selected.size === 0) return true;
  const value = extract(record);
  if (value === null) return false;
  return selected.has(value);
}

// Used by the chip UI to populate dropdown options from records the
// capture has actually seen. Models in particular need this — there
// is no closed enum of model names. Order is "first-seen" so the
// dropdown is stable across renders.
export function observedModels(records: readonly RequestRecord[]): ModelValue[] {
  const seen = new Set<ModelValue>();
  const ordered: ModelValue[] = [];
  for (const record of records) {
    const model = modelOf(record);
    if (model === null || seen.has(model)) continue;
    seen.add(model);
    ordered.push(model);
  }
  return ordered;
}

// Re-exported as the canonical message shape for tests / callers that
// want to construct a synthetic record without re-importing from the
// shared package boundary.
export type { AnthropicMessage };
