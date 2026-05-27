// [LAW:one-way-deps] This module sits at the apex of the search
// dependency edge: it imports from both `search.ts` (pure
// derivation) and `store/proxy.ts` (state read). Neither of those
// imports back, so the cycle that would otherwise form
// (proxy.ts → search.ts → useProxyStore → proxy.ts) is broken by
// keeping the React + store touchpoint here.
//
// [LAW:single-enforcer] The cache for searchText lives only here.
// Components consume through the returned SearchIndex; nothing
// else holds Map<requestId, ...> projections of the searchable
// text. The hook is stable across renders (memoized once) so
// memo deps on the returned index don't churn.

import { useMemo, useRef } from "react";
import type { RequestRecordState } from "../../../shared/proxy-events";
import { useProxyStore } from "../../store/proxy";
import { searchText, type SearchIndex } from "./search";

// Cache size at which we sweep stale entries (records whose
// requestId is no longer in state.requests because the store's
// MAX_REQUESTS trim evicted them). The factor of 2 means we tolerate
// at most one trim-worth of stale entries before reclaiming, and the
// O(cacheSize) sweep is amortized across roughly MAX_REQUESTS inserts
// — O(1) amortized per `get`. A per-event subscription would have
// paid the sweep on every appendEvent (i.e. every SSE frame), which
// is the same work done orders of magnitude more often.
const PRUNE_THRESHOLD_MULTIPLIER = 2;

// React hook that owns the search-index cache. Cache key is
// (requestId, state) — once a record reaches a terminal state
// (complete/errored), its searchText is computed once and reused;
// in-flight and streaming records recompute on each lookup (their
// content is still arriving and any cached value would be stale).
export function useSearchIndex(): SearchIndex {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

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
        maybePrune(cache);
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

// [LAW:dataflow-not-control-flow] Same code path runs on every
// `get`; the *data* (cache size relative to the live request map)
// decides whether the sweep body executes. No subscription, no
// per-event hook firing — pruning is an amortized side effect of
// the next `get` after the cache grows past the threshold.
function maybePrune(cache: Map<string, CacheEntry>): void {
  const requests = useProxyStore.getState().requests;
  if (cache.size <= requests.size * PRUNE_THRESHOLD_MULTIPLIER) return;
  for (const id of [...cache.keys()]) {
    if (!requests.has(id)) cache.delete(id);
  }
}
