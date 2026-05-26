// [LAW:dataflow-not-control-flow] Every chip always renders. The same
// FilterChip component handles every category — the only variability
// is the option list and the currently-selected Set, both flowing in
// as props. No category-specific branches in the render path.
//
// [LAW:single-enforcer] Selection state is owned by useProxyStore;
// this component is a pure projection. The store's toggleFilter is
// the only mutation path.
//
// [LAW:types-are-the-program] FilterKey + RequestFilters keep
// toggleFilter typed end-to-end for closed-enum categories —
// `toggleFilter("sizeBuckets", "success")` is a compile error.
// Models are intentionally `string` (open-set: model names come from
// the upstream provider and user aliases), so the per-call type
// constraint there is just `string`.

import { useEffect, useRef, useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { fnv1a64Hex } from "./conversation";
import {
  filtersAreEmpty,
  observedModels,
  type FilterKey,
  type RequestFilters,
  type SizeBucketValue,
  type StatusValue,
  type ToolUseValue,
  type ErrorValue,
} from "./filters";

// Options that aren't observation-driven. Models are extracted from
// actual requests; the rest are closed enums.
const STATUS_OPTIONS: readonly StatusValue[] = ["success", "error", "pending"];
const TOOL_USE_OPTIONS: readonly ToolUseValue[] = ["yes", "no"];
const ERROR_OPTIONS: readonly ErrorValue[] = ["yes", "no"];
const SIZE_OPTIONS: readonly SizeBucketValue[] = ["small", "medium", "large"];

interface FilterChipsProps {
  records: readonly RequestRecord[];
  filters: RequestFilters;
  onToggle: <K extends FilterKey>(
    key: K,
    value: SelectionValue<K>,
  ) => void;
  onClear: () => void;
}

// Mirror of the store's FilterValue<K> so callers don't have to import
// it from the store. Same shape, derived from RequestFilters.
type SelectionValue<K extends FilterKey> = RequestFilters[K] extends Set<infer V>
  ? V
  : never;

export function FilterChips({
  records,
  filters,
  onToggle,
  onClear,
}: FilterChipsProps) {
  // Single openKey coordinates dropdowns — opening one closes the rest.
  // Local UI state, no need to lift to the store.
  const [openKey, setOpenKey] = useState<FilterKey | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Option list for Model is observation-driven, but a currently-
  // selected model must always remain togglable — otherwise the chip
  // could disable itself out from under an active selection when the
  // record set drains, leaving the user with no way to deselect short
  // of Clear filters. Union the observed names with the selected
  // names; order is observed-first, selected-extras after.
  // [LAW:types-are-the-program] the type "options the user can act
  // on" is `observed ∪ selected`, not `observed`. Lifting selected
  // into the option list makes "stuck disabled with selections" an
  // unrepresentable state.
  const observed = observedModels(records);
  const modelOptions = mergeModelOptions(observed, filters.models);
  const cleared = filtersAreEmpty(filters);

  // Close on outside click. Clicking another chip is "inside" so the
  // chip's own onClick handles the transition; this only fires when
  // the click landed elsewhere on the page.
  useEffect(() => {
    if (openKey === null) return;
    function onDocClick(event: MouseEvent) {
      const el = containerRef.current;
      if (el !== null && !el.contains(event.target as Node)) {
        setOpenKey(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [openKey]);

  // [LAW:types-are-the-program] An open chip whose underlying data
  // makes it disabled is an inconsistent state — the button would
  // sit with aria-expanded="true" while the popup is suppressed by
  // `{isOpen && !disabled && ...}`, and the disabled button can't be
  // clicked to close itself. Today only Model is disablable (the
  // closed-enum categories always have options); reconcile here.
  // New disablable categories add a clause to the boolean.
  useEffect(() => {
    if (openKey === "models" && modelOptions.length === 0) setOpenKey(null);
  }, [openKey, modelOptions.length]);

  function chipProps<K extends FilterKey>(key: K) {
    return {
      isOpen: openKey === key,
      onToggleOpen: () =>
        setOpenKey((current) => (current === key ? null : key)),
      onChoose: (value: SelectionValue<K>) => onToggle(key, value),
    };
  }

  return (
    <div
      ref={containerRef}
      data-testid="filter-chips"
      className="flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-4 py-2 text-xs"
    >
      <FilterChip
        testKey="models"
        label="Model"
        emptyLabel="any"
        options={modelOptions}
        selected={filters.models}
        // Disabled only when there are no options at all — i.e.
        // nothing observed AND nothing selected. With a selection,
        // the chip stays enabled so the user can deselect it.
        disabled={modelOptions.length === 0}
        {...chipProps("models")}
      />
      <FilterChip
        testKey="statuses"
        label="Status"
        emptyLabel="any"
        options={STATUS_OPTIONS}
        selected={filters.statuses}
        {...chipProps("statuses")}
      />
      <FilterChip
        testKey="toolUse"
        label="Tool use"
        emptyLabel="any"
        options={TOOL_USE_OPTIONS}
        selected={filters.toolUse}
        {...chipProps("toolUse")}
      />
      <FilterChip
        testKey="errors"
        label="Errors"
        emptyLabel="any"
        options={ERROR_OPTIONS}
        selected={filters.errors}
        {...chipProps("errors")}
      />
      <FilterChip
        testKey="sizeBuckets"
        label="Size"
        emptyLabel="any"
        options={SIZE_OPTIONS}
        selected={filters.sizeBuckets}
        {...chipProps("sizeBuckets")}
      />
      <button
        type="button"
        onClick={onClear}
        disabled={cleared}
        data-testid="filter-chips-clear"
        className={`ml-auto rounded px-2 py-0.5 text-xs ${
          cleared
            ? "cursor-default text-neutral-700"
            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        }`}
        title={cleared ? "No filters active" : "Clear all filter chips"}
      >
        Clear filters
      </button>
    </div>
  );
}

interface FilterChipProps<V extends string> {
  // The stable identity used for test ids and the menu's a11y label.
  // Kept separate from `label` so a copy change to the user-facing
  // string never invalidates a selector. [LAW:single-enforcer]: the
  // FilterKey from the store is the canonical id; no string
  // transformation of the human label substitutes for it.
  testKey: FilterKey;
  label: string;
  emptyLabel: string;
  options: readonly V[];
  selected: Set<V>;
  disabled?: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  onChoose: (value: V) => void;
}

function FilterChip<V extends string>({
  testKey,
  label,
  emptyLabel,
  options,
  selected,
  disabled = false,
  isOpen,
  onToggleOpen,
  onChoose,
}: FilterChipProps<V>) {
  const active = selected.size > 0;
  // [LAW:types-are-the-program] aria-expanded and the popup's render
  // gate must agree in every commit, not just after the parent's
  // reconciliation effect runs. Derive `expanded` at render so the
  // inconsistent state ("expanded but no popup" / "popup but not
  // expanded") cannot exist for a single frame. The parent's
  // useEffect still resets openKey on the underlying transition so
  // re-enabling the chip later doesn't auto-reopen — but the DOM
  // invariant doesn't depend on that effect firing first.
  const expanded = isOpen && !disabled;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={disabled}
        data-testid={`filter-chip-${testKey}`}
        data-active={active ? "true" : "false"}
        aria-expanded={expanded}
        aria-haspopup="menu"
        className={`rounded border px-2 py-0.5 ${
          disabled
            ? "cursor-default border-neutral-900 text-neutral-700"
            : active
              ? "border-cyan-500 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/40"
              : "border-neutral-800 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900"
        }`}
        title={disabled ? `${label}: no values observed yet` : `Filter by ${label}`}
      >
        <span className="text-neutral-500">{label}:</span>{" "}
        <span>{summarize(selected, emptyLabel)}</span>{" "}
        <span aria-hidden className="text-neutral-500">▾</span>
      </button>
      {expanded && (
        <div
          role="menu"
          aria-label={label}
          data-testid={`filter-chip-menu-${testKey}`}
          className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg"
        >
          {options.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-neutral-500">
              No values observed yet
            </div>
          ) : (
            options.map((option) => {
              const on = selected.has(option);
              return (
                <button
                  type="button"
                  key={option}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => onChoose(option)}
                  // Slug + short hash so the testid is selector-safe
                  // AND collision-free. The slug stays readable for
                  // closed-enum values ("success", "yes", model
                  // names); the 6-hex suffix prevents two distinct
                  // raw values that happen to slug to the same form
                  // (e.g. "foo-bar" vs "foo_bar") from colliding.
                  data-testid={`filter-option-${testKey}-${optionTestSuffix(option)}`}
                  data-value={option}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-neutral-200 hover:bg-neutral-800"
                >
                  <span
                    aria-hidden
                    className={`inline-block h-3 w-3 rounded-sm border ${
                      on
                        ? "border-cyan-400 bg-cyan-500"
                        : "border-neutral-600 bg-neutral-900"
                    }`}
                  />
                  <span className="truncate">{option}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Make an option string suitable for a CSS-attribute selector AND
// guarantee uniqueness against any other raw option value. The slug
// is a readable prefix (closed-enum values like "success"/"yes" slug
// to themselves; model names stay legible); the FNV-1a-64 hash
// suffix discriminates between values that happen to share a slug
// ("foo-bar" vs "foo_bar" both slug to "foo-bar"). 6 hex chars =
// 24 bits = ~16M-keyed buckets per slug, which is far more
// resolution than any realistic option-value set needs.
// Exported so tests (and any external consumer wiring selectors)
// can build the testid the same way the component does — without
// duplicating the slug + hash rule and drifting out of sync.
export function optionTestSuffix(value: string): string {
  return `${slugify(value)}-${fnv1a64Hex(value).slice(0, 6)}`;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "x" : slug;
}

function summarize<V extends string>(selected: Set<V>, emptyLabel: string): string {
  if (selected.size === 0) return emptyLabel;
  if (selected.size === 1) {
    const [only] = selected;
    return only;
  }
  return `${selected.size} selected`;
}

// Models the user can act on = observed ∪ currently-selected. Order
// is observed-first (most familiar to the user), with any extras
// from selection appended in iteration order. Deduped.
function mergeModelOptions(
  observed: readonly string[],
  selected: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of observed) {
    if (seen.has(m)) continue;
    seen.add(m);
    ordered.push(m);
  }
  for (const m of selected) {
    if (seen.has(m)) continue;
    seen.add(m);
    ordered.push(m);
  }
  return ordered;
}
