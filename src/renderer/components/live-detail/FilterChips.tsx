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
  const models = observedModels(records);
  const hasModelOptions = models.length > 0;
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
        label="Model"
        emptyLabel="any"
        options={models}
        selected={filters.models}
        disabled={!hasModelOptions}
        {...chipProps("models")}
      />
      <FilterChip
        label="Status"
        emptyLabel="any"
        options={STATUS_OPTIONS}
        selected={filters.statuses}
        {...chipProps("statuses")}
      />
      <FilterChip
        label="Tool use"
        emptyLabel="any"
        options={TOOL_USE_OPTIONS}
        selected={filters.toolUse}
        {...chipProps("toolUse")}
      />
      <FilterChip
        label="Errors"
        emptyLabel="any"
        options={ERROR_OPTIONS}
        selected={filters.errors}
        {...chipProps("errors")}
      />
      <FilterChip
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
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={disabled}
        data-testid={`filter-chip-${label.toLowerCase().replace(/\s+/g, "-")}`}
        data-active={active ? "true" : "false"}
        aria-expanded={isOpen}
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
      {isOpen && !disabled && (
        <div
          role="menu"
          aria-label={label}
          data-testid={`filter-chip-menu-${label.toLowerCase().replace(/\s+/g, "-")}`}
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
                  data-testid={`filter-option-${option}`}
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

function summarize<V extends string>(selected: Set<V>, emptyLabel: string): string {
  if (selected.size === 0) return emptyLabel;
  if (selected.size === 1) {
    const [only] = selected;
    return only;
  }
  return `${selected.size} selected`;
}
