import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import type { LineageInfo } from "./lineage";
import {
  buildChain,
  ChainStopReasonStrip,
  StopReasonChip,
  stopReasonStyle,
} from "./stop-reason";

afterEach(() => {
  cleanup();
});

describe("stopReasonStyle", () => {
  it("maps known reasons to distinct color classes", () => {
    const tool = stopReasonStyle("tool_use").className;
    const end = stopReasonStyle("end_turn").className;
    const max = stopReasonStyle("max_tokens").className;
    const stop = stopReasonStyle("stop_sequence").className;
    expect(tool).toMatch(/cyan/);
    expect(end).toMatch(/neutral/);
    expect(max).toMatch(/amber/);
    expect(stop).toMatch(/violet/);
  });

  it("treats null as in-flight with animation", () => {
    expect(stopReasonStyle(null).className).toMatch(/animate-pulse/);
    expect(stopReasonStyle(null).label).toBe("in flight");
  });

  it("falls through unknown reasons with their literal label", () => {
    expect(stopReasonStyle("pause_turn").label).toBe("pause_turn");
  });
});

describe("StopReasonChip", () => {
  it("renders a button when onClick is provided and invokes it", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<StopReasonChip stopReason="tool_use" onClick={onClick} />);
    await user.click(screen.getByTestId("stop-reason-chip"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a span with no click handler by default", () => {
    render(<StopReasonChip stopReason="end_turn" />);
    const node = screen.getByTestId("stop-reason-chip");
    expect(node.tagName.toLowerCase()).toBe("span");
  });

  it("applies an active ring when active is true", () => {
    render(<StopReasonChip stopReason="end_turn" active />);
    expect(screen.getByTestId("stop-reason-chip").className).toMatch(/ring/);
  });
});

describe("ChainStopReasonStrip", () => {
  it("renders one chip per chain entry and selects on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const chain = [
      record("a", "tool_use"),
      record("b", "tool_use"),
      record("c", "end_turn"),
    ];
    render(
      <ChainStopReasonStrip
        chain={chain}
        selectedRequestId="b"
        onSelectRequest={onSelect}
      />,
    );
    const chips = screen.getAllByTestId("chain-stop-reason-chip");
    expect(chips).toHaveLength(3);
    expect(chips[1].className).toMatch(/ring/);
    await user.click(chips[2]);
    expect(onSelect).toHaveBeenCalledWith("c");
  });
});

describe("buildChain", () => {
  it("returns root → leaf order following parentId", () => {
    const a = record("a", "tool_use");
    const b = record("b", "tool_use");
    const c = record("c", "end_turn");
    const records = new Map([a, b, c].map((r) => [r.requestId, r]));
    const lineage = new Map<string, LineageInfo>([
      ["a", info(null, "a", 0)],
      ["b", info("a", "a", 1)],
      ["c", info("b", "a", 2)],
    ]);
    const chain = buildChain(c, lineage, records);
    expect(chain.map((r) => r.requestId)).toEqual(["a", "b", "c"]);
  });

  it("returns a singleton chain for a root with no parent", () => {
    const a = record("a", "end_turn");
    const records = new Map([[a.requestId, a]]);
    const lineage = new Map<string, LineageInfo>([["a", info(null, "a", 0)]]);
    expect(buildChain(a, lineage, records).map((r) => r.requestId)).toEqual([
      "a",
    ]);
  });
});

function record(id: string, stopReason: string | null): RequestRecord {
  return {
    requestId: id,
    clientId: "c",
    method: "POST",
    url: "/",
    status: 200,
    startedNs: 0,
    firstByteNs: 0,
    completedNs: 1,
    endedNs: 1,
    requestBody: {},
    assembledResponse:
      stopReason === null
        ? null
        : {
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

function info(
  parentId: string | null,
  rootId: string,
  depth: number,
): LineageInfo {
  return {
    parentId,
    rootId,
    depth,
    newMessages: [],
    expectedCacheTokens: null,
  };
}
