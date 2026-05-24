// [LAW:single-enforcer] Single source for stop_reason → color/label mapping.
// Both the per-request chip in RequestDetail and the chain mini-flow strip
// dispatch through stopReasonStyle — no scattered switches.
// [LAW:dataflow-not-control-flow] In-flight (null) is a stable case that
// always renders an animated chip; control flow is identical.

import type { RequestRecord } from "../../../shared/proxy-events";
import type { LineageInfo } from "./lineage";

export interface StopReasonStyle {
  label: string;
  className: string;
}

const STYLES: Record<string, StopReasonStyle> = {
  tool_use: {
    label: "tool_use",
    className: "bg-cyan-950 text-cyan-300 border-cyan-800",
  },
  end_turn: {
    label: "end_turn",
    className: "bg-neutral-900 text-neutral-300 border-neutral-700",
  },
  max_tokens: {
    label: "max_tokens",
    className: "bg-amber-950 text-amber-300 border-amber-800",
  },
  stop_sequence: {
    label: "stop_sequence",
    className: "bg-violet-950 text-violet-300 border-violet-800",
  },
  refusal: {
    label: "refusal",
    className: "bg-red-950 text-red-300 border-red-800",
  },
};

const IN_FLIGHT: StopReasonStyle = {
  label: "in flight",
  className: "bg-neutral-900 text-neutral-400 border-neutral-700 animate-pulse",
};

export function stopReasonStyle(stopReason: string | null): StopReasonStyle {
  if (stopReason === null) return IN_FLIGHT;
  return (
    STYLES[stopReason] ?? {
      label: stopReason,
      className: "bg-neutral-900 text-neutral-300 border-neutral-700",
    }
  );
}

export function StopReasonChip({
  stopReason,
  onClick,
  active = false,
  testId = "stop-reason-chip",
}: {
  stopReason: string | null;
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const style = stopReasonStyle(stopReason);
  const ring = active ? "ring-1 ring-neutral-300" : "";
  const cursor = onClick ? "cursor-pointer hover:brightness-125" : "";
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-testid={testId}
      data-stop-reason={stopReason ?? "null"}
      className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[11px] ${style.className} ${ring} ${cursor}`}
    >
      {style.label}
    </Tag>
  );
}

export function ChainStopReasonStrip({
  chain,
  selectedRequestId,
  onSelectRequest,
}: {
  chain: RequestRecord[];
  selectedRequestId: string;
  onSelectRequest: (requestId: string) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="chain-stop-reason-strip"
    >
      {chain.map((record, index) => (
        <span
          key={record.requestId}
          className="flex items-center gap-1"
          data-testid="chain-stop-reason-entry"
        >
          <StopReasonChip
            stopReason={
              record.assembledResponse?.stop_reason ??
              (record.state === "complete" ? "end_turn" : null)
            }
            active={record.requestId === selectedRequestId}
            onClick={() => onSelectRequest(record.requestId)}
            testId="chain-stop-reason-chip"
          />
          {index < chain.length - 1 ? (
            <span className="text-neutral-600">→</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function buildChain(
  leaf: RequestRecord,
  lineage: Map<string, LineageInfo>,
  recordsById: Map<string, RequestRecord>,
): RequestRecord[] {
  const reverse: RequestRecord[] = [];
  let cursor: RequestRecord | null = leaf;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor.requestId)) break;
    seen.add(cursor.requestId);
    reverse.push(cursor);
    const info = lineage.get(cursor.requestId);
    const parentId = info?.parentId ?? null;
    cursor = parentId === null ? null : (recordsById.get(parentId) ?? null);
  }
  return reverse.reverse();
}
