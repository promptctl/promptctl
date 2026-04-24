import { useMemo } from "react";
import type { ProxyEvent, RequestRecord } from "../../../shared/proxy-events";
import { formatNs, kindClass } from "./format";

export function SseTimelineTab({ record }: { record: RequestRecord }) {
  return (
    <div className="divide-y divide-neutral-900">
      {record.events.map((event) => (
        <EventRow key={event.globalSeq} event={event} />
      ))}
    </div>
  );
}

function EventRow({ event }: { event: ProxyEvent }) {
  const summary = useMemo(() => describe(event), [event]);
  return (
    <div
      className="grid grid-cols-[6rem_2.5rem_8rem_1fr] gap-2 px-4 py-1 hover:bg-neutral-900"
      data-testid="sse-event-row"
    >
      <span className="text-neutral-600" title={String(event.recvNs)}>
        {formatNs(event.recvNs)}
      </span>
      <span className="text-neutral-600">#{event.globalSeq}</span>
      <span className={kindClass(event.kind)}>{event.kind}</span>
      <span className="truncate text-neutral-300">{summary}</span>
    </div>
  );
}

function describe(event: ProxyEvent): string {
  switch (event.kind) {
    case "request_headers":
      return `${event.method} ${event.url}`;
    case "request_body": {
      if (typeof event.body === "object" && event.body !== null) {
        const b = event.body as Record<string, unknown>;
        const model = typeof b.model === "string" ? b.model : "";
        const msgs = Array.isArray(b.messages)
          ? `${b.messages.length} messages`
          : "";
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
      const body = event.body as {
        stop_reason?: string | null;
        usage?: { output_tokens?: number };
      };
      const stop = body.stop_reason ? ` stop=${body.stop_reason}` : "";
      const out = body.usage?.output_tokens ?? "?";
      return `assembled - out=${out}${stop}`;
    }
    case "response_done":
      return "--";
    case "proxy_error":
      return event.error;
  }
}

function deltaSummary(sse: {
  type: string;
  delta?: { type?: string; text?: string; partial_json?: string };
}): string {
  const d = sse.delta;
  if (!d) return "delta";
  if (d.type === "text_delta")
    return `Delta text "${truncate(d.text ?? "", 40)}"`;
  if (d.type === "input_json_delta")
    return `Delta json "${truncate(d.partial_json ?? "", 40)}"`;
  return d.type ?? "delta";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}
