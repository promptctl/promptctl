// [LAW:single-enforcer] The store owns searchQuery + searchScope; this
// component is a pure projection that calls the setters.
//
// [LAW:dataflow-not-control-flow] Scope is always either "client" or
// "global"; the toggle button always renders. No conditional that
// hides one mode — the value drives the label and aria-pressed state.

import { forwardRef } from "react";
import type { SearchScope } from "../../store/proxy";

interface SearchInputProps {
  query: string;
  scope: SearchScope;
  onChangeQuery: (next: string) => void;
  onChangeScope: (next: SearchScope) => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({ query, scope, onChangeQuery, onChangeScope }, ref) {
    const globalActive = scope === "global";
    return (
      <span
        data-testid="search-input-shell"
        className="flex items-center gap-1.5"
      >
        <input
          ref={ref}
          type="search"
          value={query}
          onChange={(event) => onChangeQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search captured requests"
          data-testid="search-input"
          className="w-40 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-500 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-700"
        />
        <button
          type="button"
          onClick={() => onChangeScope(globalActive ? "client" : "global")}
          aria-pressed={globalActive}
          data-testid="search-scope-toggle"
          title={
            globalActive
              ? "Searching across the full capture — click to scope to current filters (client tab, prompt, chips)"
              : "Searching within current filters (client tab, prompt, chips) — click to search across the full capture"
          }
          className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            globalActive
              ? "border-cyan-500 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/40"
              : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          }`}
        >
          {globalActive ? "Global" : "Client"}
        </button>
      </span>
    );
  },
);
