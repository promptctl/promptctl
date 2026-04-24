// [LAW:dataflow-not-control-flow] The Live tab renders RequestRecord
// projections from the store; live capture and replay share the same path.
import { useEffect, useMemo, useRef, useState } from "react";
import { useProxyStore, visibleRequests } from "../store/proxy";
import type { ClientInfo, ProxyEvent, RequestRecord } from "../../shared/proxy-events";

export function Live() {
  const state = useProxyStore();
  const clearEvents = useProxyStore((s) => s.clearEvents);
  const resetEvents = useProxyStore((s) => s.resetEvents);
  const selectClient = useProxyStore((s) => s.selectClient);
  const toggleRequest = useProxyStore((s) => s.toggleRequest);
  const clearInactiveClients = useProxyStore((s) => s.clearInactiveClients);
  const [follow, setFollow] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const requests = useMemo(() => visibleRequests(state), [state]);
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
      resetEvents();
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
        eventCount={[...state.requests.values()].reduce((sum, r) => sum + r.events.length, 0)}
        follow={follow}
        onToggleFollow={() => setFollow((f) => !f)}
        onClear={clearEvents}
        onResume={onResume}
      />
      <ClientTabs
        clients={[...state.clients.values()]}
        selectedClientId={state.selectedClientId}
        activeClientIds={new Set([...state.requests.values()].map((r) => r.clientId))}
        onSelect={selectClient}
        onClearInactive={clearInactiveClients}
      />
      {loadError && (
        <div className="border-b border-red-900 bg-red-950 px-4 py-2 text-xs text-red-300">
          Failed to load HAR: {loadError}
        </div>
      )}
      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-y-auto bg-neutral-950 font-mono text-xs"
      >
        {requestCount === 0 ? (
          <EmptyHint proxyUrl={proxyUrl} target={state.status.upstreamTarget} />
        ) : (
          requests.map((record) => (
            <RequestRow
              key={record.requestId}
              record={record}
              expanded={state.selectedRequestId === record.requestId}
              onToggle={() => toggleRequest(record.requestId)}
            />
          ))
        )}
      </div>
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
  status: { running: boolean; recordingPath: string | null; entryCount: number; upstreamTarget: string };
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
          {requestCount} requests · {eventCount} events · {status.entryCount} entries
        </span>
        <span className="text-neutral-500">
          HAR:{" "}
          <span className="font-mono text-neutral-300">
            {status.recordingPath ? shortPath(status.recordingPath) : "(none yet)"}
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
            {client.displayName}
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
  expanded,
  onToggle,
}: {
  record: RequestRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-neutral-900">
      <button
        onClick={onToggle}
        className="grid w-full grid-cols-[6rem_3.5rem_5rem_5rem_1fr_8rem] gap-2 px-3 py-2 text-left hover:bg-neutral-900"
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
        <span className={stateClass(record.state)}>{record.status ?? record.state}</span>
        <span className="truncate text-neutral-300">{requestSummary(record)}</span>
        <span className="text-right text-neutral-500">{record.events.length} events</span>
      </button>
      {expanded && (
        <div className="bg-neutral-950/80 pb-2">
          {record.events.map((event) => (
            <EventRow key={event.seq} event={event} />
          ))}
        </div>
      )}
    </div>
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
        <span className="font-mono text-neutral-400">{target || "(no target set)"}</span> and
        a HAR file will appear in your recordings directory once the first
        response completes.
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ProxyEvent }) {
  const summary = useMemo(() => describe(event), [event]);
  return (
    <div className="grid grid-cols-[6rem_2.5rem_8rem_1fr] gap-2 px-8 py-1 hover:bg-neutral-900">
      <span className="text-neutral-600" title={String(event.recvNs)}>
        {formatNs(event.recvNs)}
      </span>
      <span className="text-neutral-600">#{event.seq}</span>
      <span className={kindClass(event.kind)}>{event.kind}</span>
      <span className="truncate text-neutral-300">{summary}</span>
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

function describe(event: ProxyEvent): string {
  switch (event.kind) {
    case "request_headers":
      return `${event.method} ${event.url}`;
    case "request_body": {
      if (typeof event.body === "object" && event.body !== null) {
        const b = event.body as Record<string, unknown>;
        const model = typeof b.model === "string" ? b.model : "";
        const msgs = Array.isArray(b.messages) ? `${b.messages.length} messages` : "";
        return [model, msgs].filter(Boolean).join(", ") || "(json body)";
      }
      return "(body)";
    }
    case "response_headers":
      return `status ${event.status}`;
    case "sse_event":
      return event.sse.type === "content_block_delta"
        ? deltaSummary(event.sse)
        : event.sse.type;
    case "response_complete": {
      const body = event.body as { stop_reason?: string | null; usage?: { output_tokens?: number } };
      const stop = body.stop_reason ? ` stop=${body.stop_reason}` : "";
      const out = body.usage?.output_tokens ?? "?";
      return `assembled · out=${out}${stop}`;
    }
    case "response_done":
      return "—";
    case "proxy_error":
      return event.error;
  }
}

function deltaSummary(sse: { type: string; delta?: { type?: string; text?: string; partial_json?: string } }): string {
  const d = sse.delta;
  if (!d) return "delta";
  if (d.type === "text_delta") return `Δtext "${truncate(d.text ?? "", 40)}"`;
  if (d.type === "input_json_delta") return `Δjson "${truncate(d.partial_json ?? "", 40)}"`;
  return d.type ?? "delta";
}

function tabClass(active: boolean): string {
  return active
    ? "rounded bg-neutral-700 px-2 py-0.5 text-neutral-100"
    : "rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200";
}

function stateClass(state: RequestRecord["state"]): string {
  switch (state) {
    case "in_flight":
      return "text-blue-400";
    case "streaming":
      return "text-cyan-400";
    case "complete":
      return "text-green-400";
    case "errored":
      return "text-red-400";
  }
}

function kindClass(kind: ProxyEvent["kind"]): string {
  switch (kind) {
    case "request_headers":
    case "request_body":
      return "text-blue-400";
    case "response_headers":
      return "text-cyan-400";
    case "sse_event":
      return "text-neutral-500";
    case "response_complete":
      return "text-green-400";
    case "response_done":
      return "text-neutral-600";
    case "proxy_error":
      return "text-red-400";
  }
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length <= 2 ? p : `…/${parts[parts.length - 1]}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function formatNs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000) % 100_000;
  return `+${ms.toString().padStart(5, "0")}ms`;
}
