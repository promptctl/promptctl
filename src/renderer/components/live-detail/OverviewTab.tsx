import type { ReactNode } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { formatDurationNs, formatRelativeNs, stateClass } from "./format";

export function OverviewTab({ record }: { record: RequestRecord }) {
  const response = record.assembledResponse;
  const usage = response?.usage;
  const ttfb =
    record.firstByteNs === null ? null : record.firstByteNs - record.startedNs;
  const total =
    record.endedNs === null ? null : record.endedNs - record.startedNs;
  const model = modelFromRequest(record.requestBody);

  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 p-4 text-sm">
      <Label>Status</Label>
      <Value>
        <span className={stateClass(record.state)}>{record.state}</span>
        <span className="text-neutral-500">
          {" "}
          · HTTP {record.status ?? "--"}
        </span>
      </Value>

      <Label>Model</Label>
      <Value>{model}</Value>

      <Label>Started</Label>
      <Value>{formatRelativeNs(record.startedNs, record.startedNs)}</Value>

      <Label>First byte</Label>
      <Value>{formatRelativeNs(record.firstByteNs, record.startedNs)}</Value>

      <Label>Completed</Label>
      <Value>
        {formatRelativeNs(
          record.completedNs ?? record.endedNs,
          record.startedNs,
        )}
      </Value>

      <Label>TTFB</Label>
      <Value>{formatDurationNs(ttfb)}</Value>

      <Label>Total</Label>
      <Value>{formatDurationNs(total)}</Value>

      <Label>Usage</Label>
      <Value>
        in={usage?.input_tokens ?? "--"} out={usage?.output_tokens ?? "--"}{" "}
        cache_read=
        {usage?.cache_read_input_tokens ?? "--"} cache_creation=
        {usage?.cache_creation_input_tokens ?? "--"}
      </Value>

      <Label>Stop reason</Label>
      <Value>{response?.stop_reason ?? "--"}</Value>

      <Label>Error</Label>
      <Value>{record.error ?? "--"}</Value>
    </dl>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <dt className="text-neutral-500">{children}</dt>;
}

function Value({ children }: { children: ReactNode }) {
  return (
    <dd className="min-w-0 break-words font-mono text-neutral-200">
      {children}
    </dd>
  );
}

function modelFromRequest(requestBody: unknown): string {
  if (typeof requestBody !== "object" || requestBody === null) return "--";
  const model = (requestBody as Record<string, unknown>).model;
  return typeof model === "string" ? model : "--";
}
