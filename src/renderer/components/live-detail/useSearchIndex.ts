// [LAW:one-way-deps] This module sits at the apex of the search
// dependency edge: it imports from both `search.ts` (pure
// derivation) and `store/proxy.ts` (state subscription). Neither
// of those imports back, so the cycle that would otherwise form
// (proxy.ts → search.ts → useProxyStore → proxy.ts) is broken by
// moving the only React + store touchpoint out of search.ts.
//
// [LAW:single-enforcer] The cache for searchText lives only here.
// Components consume through the returned SearchIndex; nothing
// else holds Map<requestId, ...> projections of the searchable
// text. The hook is stable across renders (memoized once) so
// memo deps on the returned index don't churn.

import { useEffect, useMemo, useRef } from "react";
import type { RequestRecordState } from "../../../shared/proxy-events";
import { useProxyStore } from "../../store/proxy";
import { searchText, type SearchIndex } from "./search";

// React hook that owns the search-index cache. Cache key is
// (requestId, state) — once a record reaches a terminal state
// (complete/errored), its searchText is computed once and reused;
// in-flight and streaming records recompute on each lookup (their
// content is still arriving and any cached value would be stale).
export function useSearchIndex(): SearchIndex {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  // Prune cache entries whose record was evicted from the store
  // (MAX_REQUESTS trim). Subscribing instead of polling means the
  // cache shape tracks state.requests without per-call overhead in
  // the hot `get` path.
  useEffect(() => {
    const unsub = useProxyStore.subscribe((state, prev) => {
      if (state.requests === prev.requests) return;
      const cache = cacheRef.current;
      for (const id of cache.keys()) {
        if (!state.requests.has(id)) cache.delete(id);
      }
    });
    return unsub;
  }, []);

  return useMemo<SearchIndex>(
    () => ({
      get(record) {
        const cache = cacheRef.current;
        const cached = cache.get(record.requestId);
        if (
          cached !== undefined &&
          cached.state === record.state &&
          isTerminal(record.state)
        ) {
          return cached.text;
        }
        const text = searchText(record);
        cache.set(record.requestId, { state: record.state, text });
        return text;
      },
    }),
    [],
  );
}

interface CacheEntry {
  state: RequestRecordState;
  text: string;
}

function isTerminal(state: RequestRecordState): boolean {
  return state === "complete" || state === "errored";
}
