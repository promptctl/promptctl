// [LAW:one-source-of-truth] Latency metrics are pure derivations of
// RequestRecord timing fields; live and replay produce identical values.
// [LAW:single-enforcer] Every callsite that needs TTFB / duration / tokens-
// per-second goes through these helpers — no scattered subtractions.

import { useSyncExternalStore } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";

export interface RequestLatency {
  ttfbNs: number | null;
  durationNs: number | null;
  inFlight: boolean;
  tokensPerSec: number | null;
}

export function computeLatency(
  record: RequestRecord,
  nowNs: number,
): RequestLatency {
  const ttfbNs =
    record.firstByteNs === null ? null : record.firstByteNs - record.startedNs;
  const endNs = record.endedNs ?? record.completedNs;
  const inFlight = endNs === null;
  const durationNs = inFlight ? nowNs - record.startedNs : endNs - record.startedNs;
  const outputTokens = record.assembledResponse?.usage.output_tokens ?? null;
  const tokensPerSec =
    !inFlight &&
    outputTokens !== null &&
    record.firstByteNs !== null &&
    endNs !== null &&
    endNs > record.firstByteNs
      ? outputTokens / ((endNs - record.firstByteNs) / 1_000_000_000)
      : null;
  return { ttfbNs, durationNs, inFlight, tokensPerSec };
}

export function formatLatencyMs(ns: number | null): string {
  if (ns === null) return "--";
  const ms = ns / 1_000_000;
  if (ms < 1) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokensPerSec(value: number | null): string | null {
  if (value === null) return null;
  if (value < 10) return `${value.toFixed(1)} tok/s`;
  return `${Math.round(value)} tok/s`;
}

// ─── Shared 250ms tick for in-flight latency rendering ──────────────────────
// [LAW:single-enforcer] One interval drives every in-flight badge; per-row
// timers are forbidden. Subs is empty → timer is off (no idle wakeups).

const TICK_MS = 250;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowNs = nowNsFromDate();

function nowNsFromDate(): number {
  return Date.now() * 1_000_000;
}

function start() {
  if (timer === null && subs.size > 0) {
    timer = setInterval(() => {
      nowNs = nowNsFromDate();
      for (const s of subs) s();
    }, TICK_MS);
  }
}

function stop() {
  if (timer !== null && subs.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

export function useLiveTickNs(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      start();
      return () => {
        subs.delete(cb);
        stop();
      };
    },
    () => nowNs,
    () => nowNs,
  );
}
