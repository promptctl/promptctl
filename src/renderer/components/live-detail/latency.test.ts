import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import { computeLatency, formatLatencyMs, formatTokensPerSec } from "./latency";

describe("computeLatency", () => {
  it("returns null TTFB when firstByteNs is missing", () => {
    const r = base({ firstByteNs: null });
    expect(computeLatency(r, 0).ttfbNs).toBeNull();
  });

  it("computes TTFB and duration for completed requests", () => {
    const r = base({
      startedNs: 1_000_000_000,
      firstByteNs: 1_500_000_000,
      completedNs: 3_000_000_000,
      endedNs: 3_000_000_000,
      state: "complete",
    });
    const l = computeLatency(r, 0);
    expect(l.ttfbNs).toBe(500_000_000);
    expect(l.durationNs).toBe(2_000_000_000);
    expect(l.inFlight).toBe(false);
  });

  it("uses nowNs to compute live duration for in-flight requests", () => {
    const r = base({
      startedNs: 1_000_000_000,
      firstByteNs: 1_200_000_000,
      completedNs: null,
      endedNs: null,
      state: "streaming",
    });
    const l = computeLatency(r, 4_000_000_000);
    expect(l.inFlight).toBe(true);
    expect(l.durationNs).toBe(3_000_000_000);
    expect(l.tokensPerSec).toBeNull();
  });

  it("derives tokens/sec from output_tokens and stream window", () => {
    const r = base({
      startedNs: 0,
      firstByteNs: 0,
      completedNs: 2_000_000_000,
      endedNs: 2_000_000_000,
      state: "complete",
      assembledResponse: response(50),
    });
    const l = computeLatency(r, 0);
    expect(l.tokensPerSec).toBe(25);
  });

  it("returns null tokens/sec when output_tokens is missing", () => {
    const r = base({
      startedNs: 0,
      firstByteNs: 0,
      completedNs: 1_000_000_000,
      endedNs: 1_000_000_000,
      state: "complete",
      assembledResponse: null,
    });
    expect(computeLatency(r, 0).tokensPerSec).toBeNull();
  });
});

describe("formatLatencyMs", () => {
  it("formats sub-millisecond as decimal ms", () => {
    expect(formatLatencyMs(500_000)).toBe("0.5ms");
  });

  it("formats milliseconds as integer", () => {
    expect(formatLatencyMs(142_000_000)).toBe("142ms");
  });

  it("formats >= 1s as seconds", () => {
    expect(formatLatencyMs(3_200_000_000)).toBe("3.2s");
  });

  it("returns -- for null", () => {
    expect(formatLatencyMs(null)).toBe("--");
  });
});

describe("formatTokensPerSec", () => {
  it("returns null for null", () => {
    expect(formatTokensPerSec(null)).toBeNull();
  });

  it("uses one decimal under 10", () => {
    expect(formatTokensPerSec(7.42)).toBe("7.4 tok/s");
  });

  it("rounds at 10 and above", () => {
    expect(formatTokensPerSec(47.6)).toBe("48 tok/s");
  });
});

function base(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    requestId: "r",
    clientId: "c",
    method: "POST",
    url: "/",
    status: 200,
    startedNs: 0,
    firstByteNs: 0,
    completedNs: 0,
    endedNs: 0,
    requestBody: {},
    assembledResponse: response(0),
    error: null,
    state: "complete",
    events: [],
    ...overrides,
  };
}

function response(outputTokens: number) {
  return {
    id: "msg",
    type: "message" as const,
    role: "assistant" as const,
    model: "m",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: outputTokens },
  };
}
