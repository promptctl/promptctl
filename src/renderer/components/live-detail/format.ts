import type { ProxyEvent, RequestRecord } from "../../../shared/proxy-events";

export function tabClass(active: boolean): string {
  return active
    ? "rounded bg-neutral-700 px-2 py-0.5 text-neutral-100"
    : "rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200";
}

export function stateClass(state: RequestRecord["state"]): string {
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

export function kindClass(kind: ProxyEvent["kind"]): string {
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

export function formatNs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000) % 100_000;
  return `+${ms.toString().padStart(5, "0")}ms`;
}

export function formatDurationNs(ns: number | null): string {
  if (ns === null) return "--";
  return `${(ns / 1_000_000).toFixed(1)}ms`;
}

export function formatRelativeNs(
  valueNs: number | null,
  startedNs: number,
): string {
  if (valueNs === null) return "--";
  return `+${formatDurationNs(valueNs - startedNs)}`;
}
