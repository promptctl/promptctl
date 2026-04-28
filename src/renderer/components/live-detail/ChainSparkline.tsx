// [LAW:dataflow-not-control-flow] Sparkline always renders the chain it is
// given; chains of length 1 render a single bar, empty chains a stable
// hidden node. No early returns that change layout.
// [LAW:single-enforcer] Stop-reason coloring delegates to stopReasonStyle —
// no parallel color map.

import type { RequestRecord } from "../../../shared/proxy-events";
import { computeLatency } from "./latency";
import { stopReasonStyle } from "./stop-reason";

const WIDTH = 100;
const HEIGHT = 24;
const PAD = 2;

interface Bar {
  requestId: string;
  ttfbNs: number | null;
  stopReason: string | null;
  fillClass: string;
}

export function ChainSparkline({
  chain,
  selectedRequestId,
  onSelectRequest,
  nowNs,
}: {
  chain: RequestRecord[];
  selectedRequestId: string;
  onSelectRequest: (requestId: string) => void;
  nowNs: number;
}) {
  const bars: Bar[] = chain.map((record) => {
    const stopReason =
      record.assembledResponse?.stop_reason ??
      (record.state === "complete" ? "end_turn" : null);
    return {
      requestId: record.requestId,
      ttfbNs: computeLatency(record, nowNs).ttfbNs,
      stopReason,
      fillClass: stopReasonFill(stopReason),
    };
  });
  const maxLog = Math.max(
    ...bars.map((b) => Math.log10(Math.max(1_000_000, b.ttfbNs ?? 1_000_000))),
    Math.log10(100_000_000),
  );
  const innerHeight = HEIGHT - 2 * PAD;
  const slot = chain.length === 0 ? 0 : (WIDTH - 2 * PAD) / chain.length;

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      data-testid="chain-sparkline"
      className="overflow-visible"
      aria-label="TTFB across chain"
    >
      <rect
        x={0}
        y={0}
        width={WIDTH}
        height={HEIGHT}
        className="fill-neutral-900"
        rx={2}
      />
      {bars.map((bar, index) => {
        const ttfb = bar.ttfbNs ?? 0;
        const ratio =
          ttfb <= 0 ? 0.05 : Math.log10(Math.max(1_000_000, ttfb)) / maxLog;
        const h = Math.max(2, ratio * innerHeight);
        const x = PAD + index * slot;
        const w = Math.max(1, slot - 1);
        const isSelected = bar.requestId === selectedRequestId;
        return (
          <rect
            key={bar.requestId}
            data-testid="chain-sparkline-bar"
            data-request-id={bar.requestId}
            x={x}
            y={HEIGHT - PAD - h}
            width={w}
            height={h}
            rx={1}
            className={`${bar.fillClass} cursor-pointer ${
              isSelected ? "stroke-neutral-100" : ""
            }`}
            strokeWidth={isSelected ? 1 : 0}
            onClick={() => onSelectRequest(bar.requestId)}
          >
            <title>
              {bar.requestId.slice(0, 6)} · TTFB{" "}
              {bar.ttfbNs === null
                ? "--"
                : `${Math.round(bar.ttfbNs / 1_000_000)}ms`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function stopReasonFill(stopReason: string | null): string {
  // Mirror stopReasonStyle's color family but as fill-* utilities for SVG.
  // [LAW:single-enforcer] If a new stop_reason is added, update both maps
  // — colocated here for grep-ability with stop-reason.tsx.
  const family = stopReasonStyle(stopReason).className;
  if (family.includes("cyan")) return "fill-cyan-500";
  if (family.includes("amber")) return "fill-amber-500";
  if (family.includes("violet")) return "fill-violet-500";
  if (family.includes("red")) return "fill-red-500";
  return "fill-neutral-500";
}
