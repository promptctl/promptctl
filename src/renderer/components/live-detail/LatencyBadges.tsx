// [LAW:single-enforcer] Single component for TTFB + duration badges; both the
// request list rows and the Overview tab pass through here.
// [LAW:dataflow-not-control-flow] In-flight vs complete is data — same shell,
// different values. The shared tick (latency.ts) advances duration only when
// in-flight subscribers exist.

import type { RequestRecord } from "../../../shared/proxy-events";
import {
  computeLatency,
  formatLatencyMs,
  formatTokensPerSec,
  useLiveTickNs,
} from "./latency";

export function LatencyBadges({
  record,
  size = "row",
}: {
  record: RequestRecord;
  size?: "row" | "full";
}) {
  const inFlight = (record.endedNs ?? record.completedNs) === null;
  return inFlight ? (
    <LiveLatencyBadges record={record} size={size} />
  ) : (
    <StaticLatencyBadges record={record} size={size} />
  );
}

function LiveLatencyBadges({
  record,
  size,
}: {
  record: RequestRecord;
  size: "row" | "full";
}) {
  const nowNs = useLiveTickNs();
  const latency = computeLatency(record, nowNs);
  return <BadgeRow latency={latency} size={size} />;
}

function StaticLatencyBadges({
  record,
  size,
}: {
  record: RequestRecord;
  size: "row" | "full";
}) {
  // nowNs is unused for non-in-flight records (durationNs uses endNs).
  const latency = computeLatency(record, 0);
  return <BadgeRow latency={latency} size={size} />;
}

function BadgeRow({
  latency,
  size,
}: {
  latency: ReturnType<typeof computeLatency>;
  size: "row" | "full";
}) {
  const tps = formatTokensPerSec(latency.tokensPerSec);
  const ttfbCls =
    size === "full"
      ? "rounded bg-neutral-900 px-2 py-0.5 text-neutral-300"
      : "text-neutral-500";
  const durCls =
    size === "full"
      ? "rounded bg-neutral-900 px-2 py-0.5 text-neutral-300"
      : "text-neutral-500";
  return (
    <span
      className="inline-flex items-center gap-2 font-mono text-[11px]"
      data-testid="latency-badges"
    >
      <span className={ttfbCls} data-testid="latency-ttfb">
        TTFB {formatLatencyMs(latency.ttfbNs)}
      </span>
      <span
        className={`${durCls} ${latency.inFlight ? "animate-pulse" : ""}`}
        data-testid="latency-duration"
      >
        Δ {formatLatencyMs(latency.durationNs)}
      </span>
      {/* [LAW:dataflow-not-control-flow] tps slot exists for every record; null content keeps layout stable. */}
      <span
        aria-hidden={tps === null}
        className={tps === null ? "hidden" : "text-neutral-500"}
        data-testid="latency-tps"
      >
        {tps ?? ""}
      </span>
    </span>
  );
}
