// [LAW:one-source-of-truth] ProxyEvent remains the canonical IPC contract;
// RequestRecord and client maps are renderer-side projections derived here.
import { create } from "zustand";
import type {
  ClientInfo,
  ProxyEvent,
  ProxyStatus,
  RequestRecord,
  RequestRecordState,
} from "../../shared/proxy-events";

const MAX_REQUESTS = 1000;

interface ProxyStore {
  status: ProxyStatus;
  requests: Map<string, RequestRecord>;
  clients: Map<string, ClientInfo>;
  selectedClientId: string | null;
  selectedRequestId: string | null;
  setStatus: (status: ProxyStatus) => void;
  appendEvent: (event: ProxyEvent) => void;
  upsertClient: (info: ClientInfo) => void;
  setClients: (infos: ClientInfo[]) => void;
  selectClient: (clientId: string | null) => void;
  toggleRequest: (requestId: string) => void;
  clearInactiveClients: () => void;
  clearEvents: () => void;
}

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
  clearEvents: () => set({ requests: new Map(), selectedRequestId: null }),
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

export function visibleRequests(state: ProxyStore): RequestRecord[] {
  return sortedRequests(state.requests).filter((record) =>
    state.selectedClientId === null
      ? true
      : record.clientId === state.selectedClientId,
  );
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
