// [LAW:dataflow-not-control-flow] The Live tab renders RequestRecord
// projections from the store; live capture and replay share the same path.
import { useEffect, useMemo, useRef, useState } from "react";
import { RequestDetail } from "../components/live-detail";
import { LatencyBadges } from "../components/live-detail/LatencyBadges";
import { UsageAggregate } from "../components/live-detail/UsageAggregate";
import { UsageBadges } from "../components/live-detail/UsageBadges";
import {
  formatNs,
  stateClass,
  tabClass,
} from "../components/live-detail/format";
import { computeLineage, type LineageInfo } from "../components/live-detail/lineage";
import { buildChain } from "../components/live-detail/stop-reason";
import { ResizableSplit } from "../components/ResizableSplit";
import { useProxyStore, visibleRequests } from "../store/proxy";
import type { ClientInfo, RequestRecord } from "../../shared/proxy-events";

export function Live() {
  const state = useProxyStore();
  const clearEvents = useProxyStore((s) => s.clearEvents);
  const selectClient = useProxyStore((s) => s.selectClient);
  const toggleRequest = useProxyStore((s) => s.toggleRequest);
  const clearInactiveClients = useProxyStore((s) => s.clearInactiveClients);
  const [follow, setFollow] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const requests = useMemo(
    () => visibleRequests(state),
    [state.requests, state.selectedClientId],
  );
  const lineage = useMemo(() => computeLineage(requests), [requests]);
  const eventCount = useMemo(
    () =>
      [...state.requests.values()].reduce((sum, r) => sum + r.events.length, 0),
    [state.requests],
  );
  const activeClientIds = useMemo(
    () => new Set([...state.requests.values()].map((r) => r.clientId)),
    [state.requests],
  );
  const selectedRecord =
    state.selectedRequestId === null
      ? null
      : (requests.find(
          (record) => record.requestId === state.selectedRequestId,
        ) ?? null);
  const recordsById = useMemo(() => {
    const map = new Map<string, RequestRecord>();
    for (const r of requests) map.set(r.requestId, r);
    return map;
  }, [requests]);
  const chain = useMemo(
    () =>
      selectedRecord === null
        ? null
        : buildChain(selectedRecord, lineage, recordsById),
    [selectedRecord, lineage, recordsById],
  );
  const requestCount = state.requests.size;

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [requestCount, follow]);

  const proxyUrl = state.status.running
    ? `http://127.0.0.1:${state.status.port}`
    : "(not running)";

  async function onResume() {
    setLoadError(null);
    const filePath = await window.electronAPI.invoke("proxy:pick-har");
    if (!filePath) return;
    try {
      clearEvents();
      const next = await window.electronAPI.invoke("proxy:load-har", filePath);
      useProxyStore.getState().setStatus(next);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <StatusBar
        status={state.status}
        proxyUrl={proxyUrl}
        requestCount={requestCount}
        eventCount={eventCount}
        follow={follow}
        onToggleFollow={() => setFollow((f) => !f)}
        onClear={clearEvents}
        onResume={onResume}
      />
      <ClientTabs
        clients={[...state.clients.values()]}
        selectedClientId={state.selectedClientId}
        activeClientIds={activeClientIds}
        onSelect={selectClient}
        onClearInactive={clearInactiveClients}
      />
      {loadError && (
        <div className="border-b border-red-900 bg-red-950 px-4 py-2 text-xs text-red-300">
          Failed to load HAR: {loadError}
        </div>
      )}
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={800}
        minSize={400}
        maxSize={1400}
        className="flex-1 bg-neutral-950 font-mono text-xs"
        testId="live-split"
      >
        <div
          className="flex h-full min-h-0 flex-col"
          data-testid="live-request-list-pane"
        >
          <UsageAggregate records={requests} />
          <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto">
            {requests.length === 0 ? (
              <EmptyHint
                proxyUrl={proxyUrl}
                target={state.status.upstreamTarget}
              />
            ) : (
              requests.map((record) => (
                <RequestRow
                  key={record.requestId}
                  record={record}
                  lineage={lineage.get(record.requestId) ?? null}
                  selected={state.selectedRequestId === record.requestId}
                  onToggle={() => toggleRequest(record.requestId)}
                />
              ))
            )}
          </div>
        </div>
        {selectedRecord === null ? (
          <DetailHint />
        ) : (
          // [LAW:one-source-of-truth] RequestRecord remains the only detail source; the pane is a pure projection of the selected row.
          <RequestDetail
            record={selectedRecord}
            lineage={lineage.get(selectedRecord.requestId) ?? null}
            chain={chain}
            onSelectRequest={toggleRequest}
          />
        )}
      </ResizableSplit>
    </div>
  );
}

function StatusBar({
  status,
  proxyUrl,
  requestCount,
  eventCount,
  follow,
  onToggleFollow,
  onClear,
  onResume,
}: {
  status: {
    running: boolean;
    recordingPath: string | null;
    entryCount: number;
    upstreamTarget: string;
  };
  proxyUrl: string;
  requestCount: number;
  eventCount: number;
  follow: boolean;
  onToggleFollow: () => void;
  onClear: () => void;
  onResume: () => void;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-xs">
      <span className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${status.running ? "bg-green-500" : "bg-neutral-600"}`}
        />
        <span className="text-neutral-400">proxy</span>
        <span className="font-mono text-neutral-200">{proxyUrl}</span>
      </span>
      <span className="text-neutral-500">→</span>
      <span className="font-mono text-neutral-300" title="upstream target">
        {status.upstreamTarget || "(unset)"}
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span className="text-neutral-500">
          {requestCount} requests · {eventCount} events · {status.entryCount}{" "}
          entries
        </span>
        <span className="text-neutral-500">
          HAR:{" "}
          <span className="font-mono text-neutral-300">
            {status.recordingPath
              ? shortPath(status.recordingPath)
              : "(none yet)"}
          </span>
        </span>
        <button
          onClick={onToggleFollow}
          className={`rounded px-2 py-0.5 text-xs ${
            follow
              ? "bg-neutral-700 text-neutral-100"
              : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
          }`}
          title="Auto-scroll to new requests"
        >
          {follow ? "Follow ✓" : "Follow"}
        </button>
        <button
          onClick={onClear}
          className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Clear
        </button>
        <button
          onClick={onResume}
          className="rounded bg-blue-700 px-2 py-0.5 text-xs text-white hover:bg-blue-600"
        >
          Resume HAR…
        </button>
      </span>
    </div>
  );
}

function ClientTabs({
  clients,
  selectedClientId,
  activeClientIds,
  onSelect,
  onClearInactive,
}: {
  clients: ClientInfo[];
  selectedClientId: string | null;
  activeClientIds: Set<string>;
  onSelect: (clientId: string | null) => void;
  onClearInactive: () => void;
}) {
  const sorted = [...clients].sort((a, b) => b.lastSeenNs - a.lastSeenNs);
  return (
    <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-4 py-2 text-xs">
      <button
        onClick={() => onSelect(null)}
        className={tabClass(selectedClientId === null)}
      >
        All
      </button>
      {sorted.map((client) => {
        const active = activeClientIds.has(client.clientId);
        return (
          <button
            key={client.clientId}
            onClick={() => onSelect(client.clientId)}
            className={`${tabClass(selectedClientId === client.clientId)} ${
              active ? "" : "opacity-50"
            }`}
            title={client.command ?? client.cwd ?? client.clientId}
          >
            <span className="inline-flex items-center gap-1.5">
              {client.launchId && (
                <span
                  data-testid="live-launch-marker"
                  className="font-mono text-[9px] text-violet-300"
                  title={`launchId: ${client.launchId}`}
                >
                  ↳
                </span>
              )}
              {client.displayName}
            </span>
          </button>
        );
      })}
      <button
        onClick={onClearInactive}
        className="ml-auto rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
      >
        Clear inactive
      </button>
    </div>
  );
}

function RequestRow({
  record,
  lineage,
  selected,
  onToggle,
}: {
  record: RequestRecord;
  lineage: LineageInfo | null;
  selected: boolean;
  onToggle: () => void;
}) {
  const depth = lineage?.depth ?? 0;
  const isContinuation = (lineage?.parentId ?? null) !== null;
  return (
    <div className="border-b border-neutral-900" data-testid="live-request-row">
      <button
        onClick={onToggle}
        data-depth={depth}
        data-lineage={isContinuation ? "continuation" : "root"}
        className={`grid w-full grid-cols-[5rem_3.5rem_3.5rem_5rem_minmax(8rem,1fr)_28rem] gap-2 border-l-2 px-3 py-2 text-left hover:bg-neutral-900 ${
          selected
            ? "border-l-cyan-400 bg-neutral-800 hover:bg-neutral-800"
            : "border-l-transparent"
        }`}
      >
        <span className="text-neutral-600" title={String(record.startedNs)}>
          {formatNs(record.startedNs)}
        </span>
        <span
          className="truncate text-neutral-500"
          title={`requestId: ${record.requestId}`}
        >
          {record.requestId.slice(0, 6)}
        </span>
        <span className="text-blue-400">{record.method || "?"}</span>
        <span className={stateClass(record.state)}>
          {record.status ?? record.state}
        </span>
        {/* [LAW:dataflow-not-control-flow] Indent is data-driven; root rows render with zero-width connectors so layout stays stable. */}
        <span className="flex min-w-0 items-center">
          <ThreadConnector depth={depth} continuation={isContinuation} />
          <span className="truncate text-neutral-300">
            {requestSummary(record)}
          </span>
        </span>
        {/* [LAW:one-source-of-truth] Row usage is read from assembledResponse only; streaming rows pass null through the same renderer. */}
        <span className="flex items-center gap-3">
          <UsageBadges usage={record.assembledResponse?.usage ?? null} />
          <LatencyBadges record={record} />
        </span>
      </button>
    </div>
  );
}

function ThreadConnector({
  depth,
  continuation,
}: {
  depth: number;
  continuation: boolean;
}) {
  return (
    <span
      data-testid="thread-connector"
      data-depth={depth}
      style={{ width: `${depth * 0.75}rem` }}
      className="mr-1 inline-flex shrink-0 items-center justify-end text-neutral-700"
    >
      {continuation ? "↳" : ""}
    </span>
  );
}

function EmptyHint({ proxyUrl, target }: { proxyUrl: string; target: string }) {
  return (
    <div className="px-6 py-8 text-neutral-500">
      <div className="mb-2 text-sm text-neutral-300">No requests yet.</div>
      <div className="text-xs">Point an Anthropic API client at the proxy:</div>
      <pre className="mt-2 rounded bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
        ANTHROPIC_BASE_URL={proxyUrl} claude
      </pre>
      <div className="mt-3 text-xs text-neutral-500">
        Requests will be forwarded to{" "}
        <span className="font-mono text-neutral-400">
          {target || "(no target set)"}
        </span>{" "}
        and a HAR file will appear in your recordings directory once the first
        response completes.
      </div>
    </div>
  );
}

function requestSummary(record: RequestRecord): string {
  const url = record.url || "(unknown url)";
  const model =
    typeof record.requestBody === "object" &&
    record.requestBody !== null &&
    typeof (record.requestBody as Record<string, unknown>).model === "string"
      ? ` · ${(record.requestBody as Record<string, unknown>).model as string}`
      : "";
  return `${url}${model}`;
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length <= 2 ? p : `.../${parts[parts.length - 1]}`;
}

function DetailHint() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 text-sm text-neutral-500">
      Select a request to inspect details.
    </div>
  );
}
