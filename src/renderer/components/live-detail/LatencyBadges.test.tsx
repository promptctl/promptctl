import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import { LatencyBadges } from "./LatencyBadges";

afterEach(() => {
  cleanup();
});

describe("LatencyBadges", () => {
  it("shows TTFB and total duration for complete requests", () => {
    render(
      <LatencyBadges
        record={record({
          startedNs: 1_000_000_000,
          firstByteNs: 1_142_000_000,
          completedNs: 4_200_000_000,
          endedNs: 4_200_000_000,
          state: "complete",
        })}
      />,
    );
    expect(screen.getByTestId("latency-ttfb")).toHaveTextContent("TTFB 142ms");
    expect(screen.getByTestId("latency-duration")).toHaveTextContent("Δ 3.2s");
  });

  it("renders tokens/sec when derivable", () => {
    render(
      <LatencyBadges
        record={record({
          startedNs: 0,
          firstByteNs: 0,
          completedNs: 2_000_000_000,
          endedNs: 2_000_000_000,
          state: "complete",
          tokens: 100,
        })}
      />,
    );
    expect(screen.getByTestId("latency-tps")).toHaveTextContent("50 tok/s");
  });

  it("hides tokens/sec slot when not derivable", () => {
    render(
      <LatencyBadges
        record={record({
          startedNs: 0,
          firstByteNs: null,
          completedNs: null,
          endedNs: null,
          state: "in_flight",
        })}
      />,
    );
    const tps = screen.getByTestId("latency-tps");
    expect(tps).toHaveAttribute("aria-hidden", "true");
    expect(tps.className).toMatch(/hidden/);
  });

  it("animates duration badge when in-flight", () => {
    render(
      <LatencyBadges
        record={record({
          startedNs: 0,
          firstByteNs: 0,
          completedNs: null,
          endedNs: null,
          state: "streaming",
        })}
      />,
    );
    expect(screen.getByTestId("latency-duration").className).toMatch(
      /animate-pulse/,
    );
  });
});

function record(opts: {
  startedNs: number;
  firstByteNs: number | null;
  completedNs: number | null;
  endedNs: number | null;
  state: RequestRecord["state"];
  tokens?: number;
}): RequestRecord {
  return {
    requestId: "r",
    clientId: "c",
    method: "POST",
    url: "/",
    status: 200,
    startedNs: opts.startedNs,
    firstByteNs: opts.firstByteNs,
    completedNs: opts.completedNs,
    endedNs: opts.endedNs,
    requestBody: {},
    assembledResponse:
      opts.tokens === undefined
        ? null
        : {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "m",
            content: [],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: opts.tokens },
          },
    error: null,
    state: opts.state,
    events: [],
  };
}
