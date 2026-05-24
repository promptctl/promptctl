// Component tests for the ConversationTab. Asserts the rendered surface
// — selected-request highlight, tool-use ↔ tool-result jump links,
// attribution chips, in-flight placeholder, and the boundary stop-reason
// chip — not the implementation details of how those get there.
//
// [LAW:behavior-not-structure] Each test asserts what a user (or another
// test/agent) would observe via data-testid + textContent, never the
// component's internal state or render tree shape.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTab } from "./ConversationTab";
import type {
  AnthropicMessage,
  RequestRecord,
} from "../../../shared/proxy-events";

afterEach(() => {
  cleanup();
});

function makeRequest(
  partial: Partial<RequestRecord> & { requestId: string },
): RequestRecord {
  return {
    requestId: partial.requestId,
    clientId: partial.clientId ?? "client-1",
    method: partial.method ?? "POST",
    url: partial.url ?? "https://api.anthropic.com/v1/messages",
    status: partial.status ?? 200,
    startedNs: partial.startedNs ?? 0,
    firstByteNs: partial.firstByteNs ?? null,
    completedNs: partial.completedNs ?? null,
    endedNs: partial.endedNs ?? null,
    requestBody: partial.requestBody ?? {},
    assembledResponse: partial.assembledResponse ?? null,
    error: partial.error ?? null,
    state: partial.state ?? "complete",
    events: partial.events ?? [],
  };
}

function makeAssistant(
  id: string,
  content: { type: string; [k: string]: unknown }[],
  stopReason: string | null = "end_turn",
): AnthropicMessage {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("ConversationTab", () => {
  it("renders empty state for a null chain", () => {
    render(
      <ConversationTab chain={null} selectedRequestId="" onSelectRequest={undefined} />,
    );
    expect(screen.getByTestId("conversation-timeline")).toHaveTextContent(
      "No messages.",
    );
  });

  it("renders one message, one assistant response, and one boundary for a 1-request chain", () => {
    const rec = makeRequest({
      requestId: "req-1",
      requestBody: { messages: [{ role: "user", content: "hello" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "hi" }]),
      firstByteNs: 100_000_000,
      completedNs: 500_000_000,
    });
    render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    expect(screen.getAllByTestId("conversation-message")).toHaveLength(1);
    expect(
      screen.getAllByTestId("conversation-assistant-response"),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("conversation-boundary")).toHaveLength(1);
  });

  it("dedupes a 2-request overlapping-prefix chain to a single timeline", () => {
    const userMsg = { role: "user", content: "ping" };
    const r1 = makeRequest({
      requestId: "r1",
      requestBody: { messages: [userMsg] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "pong" }]),
    });
    const asstAsMsg = {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
    };
    const followup = { role: "user", content: "again" };
    const r2 = makeRequest({
      requestId: "r2",
      requestBody: { messages: [userMsg, asstAsMsg, followup] },
      assembledResponse: makeAssistant("asst-2", [{ type: "text", text: "still here" }]),
    });
    render(
      <ConversationTab
        chain={[r1, r2]}
        selectedRequestId="r2"
        onSelectRequest={undefined}
      />,
    );
    // 2 user messages (deduped) — the original user message is NOT
    // duplicated in r2's view.
    expect(screen.getAllByTestId("conversation-message")).toHaveLength(2);
    // 2 assistant responses (one per request) — the re-sent assistant
    // in r2's messages[] collapses into r1's assistant_response entry.
    expect(
      screen.getAllByTestId("conversation-assistant-response"),
    ).toHaveLength(2);
    expect(screen.getAllByTestId("conversation-boundary")).toHaveLength(2);
  });

  it("highlights entries belonging to the selected request", () => {
    const r1 = makeRequest({
      requestId: "r1",
      requestBody: { messages: [{ role: "user", content: "first" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "ok" }]),
    });
    const r2 = makeRequest({
      requestId: "r2",
      requestBody: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: "second" },
        ],
      },
      assembledResponse: makeAssistant("asst-2", [{ type: "text", text: "also ok" }]),
    });
    render(
      <ConversationTab
        chain={[r1, r2]}
        selectedRequestId="r2"
        onSelectRequest={undefined}
      />,
    );

    const messages = screen.getAllByTestId("conversation-message");
    // First message (the original user "first") was introduced by r1 —
    // not selected.
    expect(messages[0].getAttribute("data-selected")).toBe("false");
    // Second message (user "second") was introduced by r2 — selected.
    expect(messages[1].getAttribute("data-selected")).toBe("true");

    const responses = screen.getAllByTestId("conversation-assistant-response");
    expect(responses[0].getAttribute("data-selected")).toBe("false");
    expect(responses[1].getAttribute("data-selected")).toBe("true");
  });

  it("renders an in-flight placeholder for a streaming request with no assembled response", () => {
    const rec = makeRequest({
      requestId: "req-streaming",
      requestBody: { messages: [{ role: "user", content: "tell me" }] },
      assembledResponse: null,
      state: "streaming",
    });
    render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-streaming"
        onSelectRequest={undefined}
      />,
    );
    expect(screen.getByTestId("conversation-in-flight")).toBeInTheDocument();
    // The boundary still renders — its stop_reason is null → in-flight chip.
    const boundary = screen.getByTestId("conversation-boundary");
    expect(boundary.getAttribute("data-active")).toBe("true");
  });

  it("attribution chip click invokes onSelectRequest with the request id", () => {
    const onSelect = vi.fn();
    const rec = makeRequest({
      requestId: "req-abc12345",
      requestBody: { messages: [{ role: "user", content: "x" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "y" }]),
    });
    render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-other"
        onSelectRequest={onSelect}
      />,
    );
    const chips = screen.getAllByTestId("conversation-attribution-chip");
    fireEvent.click(chips[0]);
    expect(onSelect).toHaveBeenCalledWith("req-abc12345");
  });

  it("renders a `→ result` link on a tool_use that has a paired tool_result", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_xyz",
      name: "Read",
      input: { path: "/a" },
    };
    const toolResult = {
      type: "tool_result",
      tool_use_id: "toolu_xyz",
      content: "result content",
    };
    const r1 = makeRequest({
      requestId: "r1",
      requestBody: { messages: [{ role: "user", content: "go" }] },
      assembledResponse: makeAssistant("asst-1", [toolUse], "tool_use"),
    });
    const r2 = makeRequest({
      requestId: "r2",
      requestBody: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [toolUse] },
          { role: "user", content: [toolResult] },
        ],
      },
      assembledResponse: makeAssistant("asst-2", [{ type: "text", text: "done" }]),
    });
    render(
      <ConversationTab
        chain={[r1, r2]}
        selectedRequestId="r1"
        onSelectRequest={undefined}
      />,
    );
    const useJumpButtons = screen.getAllByTestId("conversation-tool-use-jump");
    expect(useJumpButtons.length).toBeGreaterThan(0);
    expect(useJumpButtons[0]).toHaveTextContent("→ result");
    const resultJumpButtons = screen.getAllByTestId(
      "conversation-tool-result-jump",
    );
    expect(resultJumpButtons.length).toBeGreaterThan(0);
    expect(resultJumpButtons[0]).toHaveTextContent("← input");
  });

  it("renders TTFB and tokens on the boundary when available", () => {
    const rec = makeRequest({
      requestId: "req-1",
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "y" }]),
      startedNs: 0,
      firstByteNs: 142_000_000, // 142ms
      completedNs: 3_200_000_000, // 3200ms
    });
    render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    const boundary = screen.getByTestId("conversation-boundary");
    expect(
      within(boundary).getByTestId("conversation-boundary-ttfb"),
    ).toHaveTextContent("TTFB 142ms");
    expect(
      within(boundary).getByTestId("conversation-boundary-duration"),
    ).toHaveTextContent("Δ 3200ms");
    expect(
      within(boundary).getByTestId("conversation-boundary-tokens"),
    ).toHaveTextContent("10↓ 5↑ tok");
  });

  it("re-renders the timeline when a streaming request transitions to complete (memo invalidation)", () => {
    // [LAW:types-are-the-program] The memo key must encode every
    // dimension of "did the projection change". A streaming request
    // transitioning to complete (assembledResponse becomes non-null,
    // state flips) keeps the requestId set the same — the memo would
    // not invalidate if keyed only on requestIds. Pin the corrected
    // behavior: the in-flight placeholder is REPLACED by the assembled
    // response on the next render.
    const streaming = makeRequest({
      requestId: "req-1",
      requestBody: { messages: [{ role: "user", content: "go" }] },
      assembledResponse: null,
      state: "streaming",
    });
    const { rerender } = render(
      <ConversationTab
        chain={[streaming]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    expect(screen.getByTestId("conversation-in-flight")).toBeInTheDocument();

    // Same requestId, but the record completed.
    const completed = makeRequest({
      requestId: "req-1",
      requestBody: { messages: [{ role: "user", content: "go" }] },
      assembledResponse: makeAssistant("asst-1", [
        { type: "text", text: "done" },
      ]),
      state: "complete",
    });
    rerender(
      <ConversationTab
        chain={[completed]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    // The in-flight placeholder is gone; the assembled response is in.
    expect(screen.queryByTestId("conversation-in-flight")).toBeNull();
    const response = screen.getByTestId("conversation-assistant-response");
    expect(response).toHaveTextContent("done");
  });

  it("renders boundary request-id as a static span when no onSelectRequest is provided", () => {
    // [LAW:single-enforcer] A no-op button is a focus trap with no
    // affordance — when there is no handler, render a static span so
    // the DOM semantics match the actual behavior.
    const rec = makeRequest({
      requestId: "req-abcdef",
      requestBody: { messages: [{ role: "user", content: "x" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "y" }]),
    });
    render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-abcdef"
        onSelectRequest={undefined}
      />,
    );
    const link = screen.getByTestId("conversation-boundary-request-link");
    expect(link.tagName).toBe("SPAN");
    // And the attribution chip on the entry.
    const chip = screen.getAllByTestId("conversation-attribution-chip")[0];
    expect(chip.tagName).toBe("SPAN");
  });

  it("[LAW:dataflow-not-control-flow] re-rendering with the same chain produces identical DOM", () => {
    // Live and replay flow into the same projection; rendering with the
    // same chain twice must produce the same DOM tree. (We're not
    // snapshotting against a fixture; we're asserting idempotency.)
    const rec = makeRequest({
      requestId: "req-1",
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      assembledResponse: makeAssistant("asst-1", [{ type: "text", text: "y" }]),
    });
    const { container, rerender } = render(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    const first = container.innerHTML;
    rerender(
      <ConversationTab
        chain={[rec]}
        selectedRequestId="req-1"
        onSelectRequest={undefined}
      />,
    );
    expect(container.innerHTML).toBe(first);
  });
});
