import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import { ChainSparkline } from "./ChainSparkline";

afterEach(() => {
  cleanup();
});

function noop() {
  // intentional no-op
}

describe("ChainSparkline", () => {
  it("renders one bar per chain entry without layout shift across chain lengths", () => {
    for (const n of [1, 2, 10]) {
      cleanup();
      const chain = Array.from({ length: n }, (_, i) =>
        record(`r${i}`, "tool_use", 100_000_000),
      );
      render(
        <ChainSparkline
          chain={chain}
          selectedRequestId="r0"
          onSelectRequest={noop}
          nowNs={0}
        />,
      );
      expect(screen.getAllByTestId("chain-sparkline-bar")).toHaveLength(n);
      const svg = screen.getByTestId("chain-sparkline");
      expect(svg.getAttribute("width")).toBe("100");
      expect(svg.getAttribute("height")).toBe("24");
    }
  });

  it("colors bars by stop_reason family", () => {
    const chain = [
      record("a", "tool_use", 100_000_000),
      record("b", "max_tokens", 100_000_000),
      record("c", "end_turn", 100_000_000),
    ];
    render(
      <ChainSparkline
        chain={chain}
        selectedRequestId="a"
        onSelectRequest={noop}
        nowNs={0}
      />,
    );
    const bars = screen.getAllByTestId("chain-sparkline-bar");
    expect(bars[0].getAttribute("class")).toMatch(/cyan/);
    expect(bars[1].getAttribute("class")).toMatch(/amber/);
    expect(bars[2].getAttribute("class")).toMatch(/neutral/);
  });

  it("invokes onSelectRequest with the clicked bar's requestId", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ChainSparkline
        chain={[
          record("a", "tool_use", 100_000_000),
          record("b", "end_turn", 100_000_000),
        ]}
        selectedRequestId="a"
        onSelectRequest={onSelect}
        nowNs={0}
      />,
    );
    const bars = screen.getAllByTestId("chain-sparkline-bar");
    await user.click(bars[1]);
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

function record(
  id: string,
  stopReason: string,
  ttfbNs: number,
): RequestRecord {
  return {
    requestId: id,
    clientId: "c",
    method: "POST",
    url: "/",
    status: 200,
    startedNs: 0,
    firstByteNs: ttfbNs,
    completedNs: ttfbNs * 2,
    endedNs: ttfbNs * 2,
    requestBody: {},
    assembledResponse: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    error: null,
    state: "complete",
    events: [],
  };
}
