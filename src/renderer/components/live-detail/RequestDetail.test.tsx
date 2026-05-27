import { cleanup, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import {
  installElectronMock,
  type MockElectronAPI,
} from "../../../test/electron-mock";
import { setupUser } from "../../../test/user-event";
import { RequestDetail } from "./RequestDetail";

let electron: MockElectronAPI;

beforeEach(() => {
  cleanup();
  electron = installElectronMock();
});

describe("RequestDetail", () => {
  it("renders overview, request, response, timeline, and raw projections", async () => {
    const user = setupUser();
    const record = requestRecord();
    render(<RequestDetail record={record} />);

    expect(screen.getByText("complete")).toBeInTheDocument();
    expect(screen.getByTestId("usage-pill-input")).toHaveTextContent("in10");
    expect(screen.getByTestId("usage-pill-output")).toHaveTextContent("out20");
    expect(screen.getByTestId("usage-pill-cache-read")).toHaveTextContent(
      "cache·3",
    );
    expect(screen.getByTestId("usage-pill-cache-creation")).toHaveTextContent(
      "cache+4",
    );
    expect(screen.getAllByText("end_turn").length).toBeGreaterThan(0);
    expect(screen.getByTestId("request-stop-reason-chip")).toHaveTextContent(
      "end_turn",
    );
    expect(screen.getByText("+0.0ms")).toBeInTheDocument();
    expect(screen.getByText("+15.0ms")).toBeInTheDocument();
    expect(screen.getByText("+30.0ms")).toBeInTheDocument();
    expect(screen.getByText("15.0ms")).toBeInTheDocument();
    expect(screen.getByText("30.0ms")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request" }));
    expect(screen.getByText("Messages (2)")).toBeInTheDocument();
    expect(screen.getAllByTestId("request-message")).toHaveLength(2);
    expect(screen.getByText("Tools (1)")).toBeInTheDocument();
    expect(screen.getAllByText("search_web").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Response" }));
    expect(screen.getByText("Hello response")).toBeInTheDocument();
    expect(screen.getByText(/tool_use/)).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "SSE Timeline" }));
    expect(screen.getAllByTestId("sse-event-row")).toHaveLength(
      record.events.length,
    );
    expect(screen.getByText("response_complete")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Raw" }));
    const rawRequestBlock = screen.getByText("Request body").closest("details");
    expect(rawRequestBlock).not.toBeNull();
    await user.click(within(rawRequestBlock as HTMLElement).getByText("Copy"));
    expect(electron.writeClipboard).toHaveBeenCalledWith(
      JSON.stringify(record.requestBody, null, 2),
    );
  });

  it("surfaces request errors above the tab strip", () => {
    const record = {
      ...requestRecord(),
      error: "upstream connection reset",
      state: "errored" as const,
    };

    render(<RequestDetail record={record} />);

    expect(screen.getByText("Request failed")).toBeInTheDocument();
    expect(
      screen.getAllByText("upstream connection reset").length,
    ).toBeGreaterThan(0);
  });
});

function requestRecord(): RequestRecord {
  return {
    requestId: "req-a",
    clientId: "client-a",
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: 200,
    startedNs: 1_000_000,
    firstByteNs: 16_000_000,
    completedNs: 31_000_000,
    endedNs: 31_000_000,
    requestBody: {
      model: "claude-test",
      system: "Be concise.",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search_web",
              input: { q: "docs" },
            },
          ],
        },
      ],
      tools: [{ name: "search_web", input_schema: { type: "object" } }],
    },
    assembledResponse: {
      id: "msg_req-a",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "Hello response" },
        { type: "tool_use", id: "toolu_2", name: "lookup", input: { id: 123 } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    },
    error: null,
    state: "complete",
    events: [
      {
        requestId: "req-a",
        clientId: "client-a",
        globalSeq: 1,
        recvNs: 1_000_000,
        kind: "request_headers",
        method: "POST",
        url: "https://api.example.test/v1/messages",
        headers: {},
      },
      {
        requestId: "req-a",
        clientId: "client-a",
        globalSeq: 2,
        recvNs: 2_000_000,
        kind: "request_body",
        body: {
          model: "claude-test",
          messages: [{ role: "user", content: "Hello" }],
        },
      },
      {
        requestId: "req-a",
        clientId: "client-a",
        globalSeq: 3,
        recvNs: 31_000_000,
        kind: "response_complete",
        body: {
          id: "msg_req-a",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
    ],
  };
}
