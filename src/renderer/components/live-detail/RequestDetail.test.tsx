import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import {
  installElectronMock,
  type MockElectronAPI,
} from "../../../test/electron-mock";
import { setupUser } from "../../../test/user-event";
import { RequestDetail } from "./RequestDetail";

// [LAW:locality-or-seam] OpenPaneButton (inside RequestDetail) calls
// useNavigate from react-router; tests need a Router in scope. The
// memory variant has no URL side-effects so each test starts clean.
function renderDetail(ui: ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

let electron: MockElectronAPI;

beforeEach(() => {
  cleanup();
  electron = installElectronMock();
});

describe("RequestDetail", () => {
  it("renders overview, request, response, timeline, and raw projections", async () => {
    const user = setupUser();
    const record = requestRecord();
    renderDetail(<RequestDetail record={record} />);

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

  it("auto-scrolls the first search-highlight into view when a query is active", async () => {
    const user = setupUser();
    const record = requestRecord();
    const scrollSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView; install a spy on the prototype
    // so the effect can find a callable method via element.scrollIntoView.
    const originalScrollIntoView = (
      HTMLElement.prototype as unknown as {
        scrollIntoView?: (...args: unknown[]) => void;
      }
    ).scrollIntoView;
    (
      HTMLElement.prototype as unknown as {
        scrollIntoView: (...args: unknown[]) => void;
      }
    ).scrollIntoView = scrollSpy;
    try {
      const { rerender } = renderDetail(
        <RequestDetail record={record} highlightQuery="" />,
      );
      // No query → no auto-scroll yet, even on tab switch.
      await user.click(screen.getByRole("button", { name: "Response" }));
      expect(scrollSpy).not.toHaveBeenCalled();

      // Activating a query that matches "Hello response" must scroll the
      // first <mark> into view on the active (Response) tab.
      rerender(
        <MemoryRouter>
          <RequestDetail record={record} highlightQuery="hello" />
        </MemoryRouter>,
      );
      expect(scrollSpy).toHaveBeenCalled();
      const lastCallTarget = (scrollSpy.mock.contexts.at(-1) ??
        null) as HTMLElement | null;
      expect(lastCallTarget).not.toBeNull();
      expect(lastCallTarget?.dataset.testid ?? "").toBe("search-highlight");

      // Switching tabs while a query is active triggers a fresh scroll on
      // the new tab's first match.
      scrollSpy.mockClear();
      await user.click(screen.getByRole("button", { name: "Request" }));
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView === undefined) {
        delete (
          HTMLElement.prototype as unknown as {
            scrollIntoView?: unknown;
          }
        ).scrollIntoView;
      } else {
        (
          HTMLElement.prototype as unknown as {
            scrollIntoView: (...args: unknown[]) => void;
          }
        ).scrollIntoView = originalScrollIntoView;
      }
    }
  });

  it("surfaces request errors above the tab strip", () => {
    const record = {
      ...requestRecord(),
      error: "upstream connection reset",
      state: "errored" as const,
    };

    renderDetail(<RequestDetail record={record} />);

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
