// [LAW:one-source-of-truth] ProxyEvent remains the canonical IPC contract;
// RequestRecord and client maps are renderer-side projections derived here.
import { create } from "zustand";
import {
  emptyFilters,
  passesFilters,
  type FilterKey,
  type RequestFilters,
} from "../components/live-detail/filters";
import { systemPromptHash } from "../components/live-detail/promptHash";
import {
  normalizeQuery,
  recordMatchesSearch,
  type SearchIndex,
} from "../components/live-detail/search";
import type {
  ClientInfo,
  ProxyEvent,
  ProxyStatus,
  RequestRecord,
  RequestRecordState,
} from "../../shared/proxy-events";

const MAX_REQUESTS = 1000;

export type SearchScope = "client" | "global";

interface ProxyStore {
  status: ProxyStatus;
  requests: Map<string, RequestRecord>;
  clients: Map<string, ClientInfo>;
  selectedClientId: string | null;
  selectedRequestId: string | null;
  // [LAW:single-enforcer] One filter slice; visibleRequests is the
  // single consumer that composes selectedClientId AND selectedPromptHash
  // AND searchQuery/scope AND filters into the displayed list. No other
  // code path filters the request list — every component reads through
  // visibleRequests.
  selectedPromptHash: string | null;
  filters: RequestFilters;
  // Search is a singleton dimension (one query, one scope) — kept
  // inline alongside the other store-level singletons. Chip-category
  // dimensions live in filters.ts; new singletons land here.
  searchQuery: string;
  searchScope: SearchScope;
  setStatus: (status: ProxyStatus) => void;
  appendEvent: (event: ProxyEvent) => void;
  upsertClient: (info: ClientInfo) => void;
  setClients: (infos: ClientInfo[]) => void;
  selectClient: (clientId: string | null) => void;
  selectPromptHash: (hash: string | null) => void;
  toggleFilter: <K extends FilterKey>(key: K, value: FilterValue<K>) => void;
  clearFilters: () => void;
  setSearchQuery: (query: string) => void;
  setSearchScope: (scope: SearchScope) => void;
  toggleRequest: (requestId: string) => void;
  clearInactiveClients: () => void;
  clearEvents: () => void;
}

// Type helper — pulls the value type out of a Set-typed slice. Keeps
// toggleFilter typed end-to-end for categories whose value type is a
// closed enum: `toggleFilter("sizeBuckets", "success")` is a compile
// error because "success" is not assignable to SizeBucketValue. Models
// are intentionally `string` (model names are open-set — Anthropic
// publishes new ones, users alias their own), so no per-call type
// constraint exists for `toggleFilter("models", ...)` beyond `string`.
type FilterValue<K extends FilterKey> = RequestFilters[K] extends Set<infer V>
  ? V
  : never;

const INITIAL_STATUS: ProxyStatus = {
  running: false,
  port: 0,
  upstreamTarget: "",
  recordingPath: null,
  entryCount: 0,
};

export const useProxyStore = create<ProxyStore>((set) => ({
  status: INITIAL_STATUS,
  requests: new Map(),
  clients: new Map(),
  selectedClientId: null,
  selectedRequestId: null,
  selectedPromptHash: null,
  filters: emptyFilters(),
  searchQuery: "",
  searchScope: "client",
  setStatus: (status) => set({ status }),
  appendEvent: (event) =>
    set((state) => {
      const clients = new Map(state.clients);
      clients.set(
        event.clientId,
        clientFromEvent(event, clients.get(event.clientId)),
      );
      const requests = foldRequests(state.requests, event);
      const selectedRequestId =
        state.selectedRequestId !== null &&
        !requests.has(state.selectedRequestId)
          ? null
          : state.selectedRequestId;
      return {
        requests,
        clients,
        selectedRequestId,
      };
    }),
  upsertClient: (info) =>
    set((state) => ({
      clients: new Map(state.clients).set(info.clientId, info),
    })),
  setClients: (infos) =>
    set((state) => {
      const clients = new Map(state.clients);
      for (const info of infos) clients.set(info.clientId, info);
      return { clients };
    }),
  selectClient: (clientId) =>
    set({ selectedClientId: clientId, selectedRequestId: null }),
  // Toggle semantics match selectClient: re-selecting the active hash
  // clears the filter. selectedRequestId clears so a row that's no
  // longer visible can't stay "selected" in stale state.
  selectPromptHash: (hash) =>
    set((state) => ({
      selectedPromptHash: state.selectedPromptHash === hash ? null : hash,
      selectedRequestId: null,
    })),
  // Toggle one value within one category. Membership is the source of
  // truth — `[LAW:types-are-the-program]`: empty Set is the no-filter
  // identity, so no separate "active?" flag is needed. selectedRequestId
  // clears so a row that drops out of the filter can't stay "selected".
  toggleFilter: (key, value) =>
    set((state) => {
      const current = state.filters[key];
      const next = new Set(current) as typeof current;
      // Cast scope is one line — `value` is `FilterValue<K>` and
      // `current` is `Set<FilterValue<K>>`; the TS inference loses
      // that link across the union of K, so we collapse it here.
      if (next.has(value as never)) next.delete(value as never);
      else next.add(value as never);
      return {
        filters: { ...state.filters, [key]: next },
        selectedRequestId: null,
      };
    }),
  clearFilters: () =>
    set({ filters: emptyFilters(), selectedRequestId: null }),
  // Editing the query never clears the selected request — the user
  // is typing to find/refocus; ripping out their selection would
  // fight that. If narrowing drops the selection out of the visible
  // list, Live's `selectedRecord = requests.find(...) ?? null`
  // safeguard renders the empty-detail hint, same as if the row
  // had scrolled offscreen.
  setSearchQuery: (query) => set({ searchQuery: query }),
  // Scope changes don't clear selection either: the same safeguard
  // handles the rare case where flipping to a narrower scope drops
  // the current selection. When the query is empty, scope changes
  // are a no-op for visibleRequests — clearing would be a spurious
  // deselection with no UI justification.
  setSearchScope: (scope) => set({ searchScope: scope }),
  toggleRequest: (requestId) =>
    set((state) => ({
      selectedRequestId:
        state.selectedRequestId === requestId ? null : requestId,
    })),
  clearInactiveClients: () =>
    set((state) => {
      const activeClientIds = new Set(
        [...state.requests.values()].map((r) => r.clientId),
      );
      const clients = new Map(
        [...state.clients.entries()].filter(([clientId]) =>
          activeClientIds.has(clientId),
        ),
      );
      return {
        clients,
        selectedClientId:
          state.selectedClientId !== null &&
          !clients.has(state.selectedClientId)
            ? null
            : state.selectedClientId,
      };
    }),
  clearEvents: () =>
    set({
      requests: new Map(),
      selectedRequestId: null,
      selectedPromptHash: null,
      filters: emptyFilters(),
      searchQuery: "",
      searchScope: "client",
    }),
}));


export function initProxySubscription(): () => void {
  const unsubEvent = window.electronAPI.on("proxy:event", (event) => {
    useProxyStore.getState().appendEvent(event as ProxyEvent);
  });
  const unsubStatus = window.electronAPI.on("proxy:status", (status) => {
    useProxyStore.getState().setStatus(status as ProxyStatus);
  });
  const unsubClient = window.electronAPI.on("proxy:client", (info) => {
    useProxyStore.getState().upsertClient(info as ClientInfo);
  });
  const unsubClients = window.electronAPI.on("proxy:clients", (infos) => {
    useProxyStore.getState().setClients(infos as ClientInfo[]);
  });
  window.electronAPI.send("proxy:subscribe");
  void window.electronAPI.invoke("proxy:list-clients").then((infos) => {
    useProxyStore.getState().setClients(infos as ClientInfo[]);
  });
  return () => {
    unsubEvent();
    unsubStatus();
    unsubClient();
    unsubClients();
    window.electronAPI.send("proxy:unsubscribe");
  };
}

export function visibleRequests(
  state: ProxyStore,
  searchIndex: SearchIndex,
): RequestRecord[] {
  // [LAW:single-enforcer] One filter composition pipeline for the
  // request list. Three layers, all routed through this function:
  //   - Store-level singletons (selectedClientId, selectedPromptHash,
  //     searchQuery/searchScope) inline here — they're scalars, not
  //     chip categories.
  //   - Chip-category dimensions (model, status, tool-use, errors,
  //     size) inside `passesFilters` in filters.ts.
  // A new chip dimension is one entry in filters.ts; a new
  // store-level singleton is one inline clause here. Either way the
  // composition fans into a single AND chain, and no other code path
  // filters the request list.
  //
  // Search is the special case: when scope is "global" AND a query
  // is active, search becomes the ONLY gate — the user is asking
  // "find this string anywhere in the capture," and the existing
  // client/prompt/chip filters would silently swallow the answer.
  const query = normalizeQuery(state.searchQuery);
  const globalSearchOverride = query !== "" && state.searchScope === "global";
  return sortedRequests(state.requests).filter((record) => {
    if (globalSearchOverride) {
      return recordMatchesSearch(record, query, searchIndex);
    }
    if (
      state.selectedClientId !== null &&
      record.clientId !== state.selectedClientId
    ) {
      return false;
    }
    if (state.selectedPromptHash !== null) {
      if (systemPromptHash(record.requestBody) !== state.selectedPromptHash) {
        return false;
      }
    }
    if (!passesFilters(record, state.filters)) return false;
    return recordMatchesSearch(record, query, searchIndex);
  });
}

export function foldRequests(
  current: Map<string, RequestRecord>,
  event: ProxyEvent,
): Map<string, RequestRecord> {
  const next = new Map(current);
  const previous = next.get(event.requestId);
  const record = applyEvent(previous ?? newRecord(event), event);
  next.set(record.requestId, record);
  return trimRequests(next);
}

function applyEvent(record: RequestRecord, event: ProxyEvent): RequestRecord {
  const updated: RequestRecord = {
    ...record,
    clientId: event.clientId,
    events: [...record.events, event],
  };

  switch (event.kind) {
    case "request_headers":
      return {
        ...updated,
        method: event.method,
        url: event.url,
        state: "in_flight",
      };
    case "request_body":
      return { ...updated, requestBody: event.body };
    case "response_headers":
      return {
        ...updated,
        status: event.status,
        firstByteNs: event.recvNs,
        state: "streaming",
      };
    case "sse_event":
      return { ...updated, state: "streaming" };
    case "response_complete":
      return {
        ...updated,
        assembledResponse: event.body,
        completedNs: event.recvNs,
        state: nextState(updated.state, "complete"),
      };
    case "response_done":
      return {
        ...updated,
        endedNs: event.recvNs,
        state: nextState(updated.state, "complete"),
      };
    case "proxy_error":
      return {
        ...updated,
        error: event.error,
        endedNs: event.recvNs,
        state: "errored",
      };
  }
}

function nextState(
  current: RequestRecordState,
  target: RequestRecordState,
): RequestRecordState {
  return current === "errored" ? current : target;
}

function newRecord(event: ProxyEvent): RequestRecord {
  return {
    requestId: event.requestId,
    clientId: event.clientId,
    method: "",
    url: "",
    status: null,
    startedNs: event.recvNs,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: null,
    assembledResponse: null,
    error: null,
    state: "in_flight",
    events: [],
  };
}

function trimRequests(
  records: Map<string, RequestRecord>,
): Map<string, RequestRecord> {
  const sorted = sortedRequests(records);
  const keep = sorted.slice(Math.max(0, sorted.length - MAX_REQUESTS));
  return new Map(keep.map((record) => [record.requestId, record]));
}

function sortedRequests(records: Map<string, RequestRecord>): RequestRecord[] {
  return [...records.values()].sort((a, b) => a.startedNs - b.startedNs);
}

function clientFromEvent(
  event: ProxyEvent,
  previous: ClientInfo | undefined,
): ClientInfo {
  return {
    clientId: event.clientId,
    pid: previous?.pid ?? null,
    rootPid: previous?.rootPid ?? null,
    displayName: previous?.displayName ?? event.clientId,
    command: previous?.command ?? null,
    cwd: previous?.cwd ?? null,
    lastSeenNs: event.recvNs,
    launchId: previous?.launchId ?? null,
  };
}
