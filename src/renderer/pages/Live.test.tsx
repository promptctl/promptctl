import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Live } from "./Live";
import { useProxyStore } from "../store/proxy";
import type { ClientInfo, ProxyEvent } from "../../shared/proxy-events";
import { installElectronMock } from "../../test/electron-mock";

beforeEach(() => {
  cleanup();
  installElectronMock();
  useProxyStore.setState({
    status: {
      running: true,
      port: 9999,
      upstreamTarget: "https://api.example.test",
      recordingPath: null,
      entryCount: 0,
    },
    requests: new Map(),
    clients: new Map(),
    selectedClientId: null,
    selectedRequestId: null,
  });
});

describe("Live", () => {
  it("renders grouped request rows, client tabs, filtering, and request detail pane", async () => {
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    state.upsertClient(client("client-b", "Codex @ app"));
    for (const event of [
      ...events("req-a", "client-a"),
      ...events("req-b", "client-b"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    render(<Live />);

    expect(screen.getByText("Claude @ app")).toBeTruthy();
    expect(screen.getByText("Codex @ app")).toBeTruthy();
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/req-b/).length).toBeGreaterThan(0);
    const allTotals = screen.getByText("Totals · 2 requests").parentElement;
    expect(allTotals).not.toBeNull();
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-input"),
    ).toHaveTextContent("in30");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-cache-creation"),
    ).toHaveTextContent("cache+5");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-cache-read"),
    ).toHaveTextContent("cache·7");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-output"),
    ).toHaveTextContent("out7");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-segment-cache-read"),
    ).toHaveAttribute("data-share", String(7 / 42));
    expect(screen.getByTestId("live-request-list-pane")).toHaveClass(
      "w-[50rem]",
    );
    expect(screen.getAllByText(/req-a/)[0].closest("button")).toHaveClass(
      "grid-cols-[5rem_3.5rem_3.5rem_5rem_minmax(8rem,1fr)_20rem]",
    );

    const user = userEvent.setup();
    await user.click(screen.getByText("Claude @ app"));
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/req-b/)).toBeNull();
    const clientTotals = screen.getByText("Totals · 1 request").parentElement;
    expect(clientTotals).not.toBeNull();
    expect(
      within(clientTotals as HTMLElement).getByTestId("usage-pill-input"),
    ).toHaveTextContent("in10");

    await user.click(screen.getByText("All"));
    await user.click(screen.getAllByText(/req-a/)[0]);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText(/HTTP --/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Request" }));
    expect(screen.getAllByText(/claude-test/).length).toBeGreaterThan(0);

    await user.click(screen.getAllByText(/req-b/)[0]);
    expect(screen.getByText("Messages (1)")).toBeTruthy();
    expect(screen.getByText("hello req-b")).toBeTruthy();

    await user.click(screen.getAllByText(/req-b/)[0]);
    expect(
      screen.getByText("Select a request to inspect details."),
    ).toBeTruthy();
  });
});

function client(clientId: string, displayName: string): ClientInfo {
  return {
    clientId,
    pid: null,
    rootPid: null,
    displayName,
    command: null,
    cwd: null,
    lastSeenNs: 1,
  };
}

function events(requestId: string, clientId: string): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 1 : 3,
      recvNs: 1,
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 2 : 4,
      recvNs: 2,
      kind: "request_body",
      body: {
        model: "claude-test",
        system: "Test system",
        messages: [{ role: "user", content: `hello ${requestId}` }],
      },
    },
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 3 : 5,
      recvNs: 3,
      kind: "response_complete",
      body: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage:
          requestId === "req-a"
            ? {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_input_tokens: 7,
                cache_creation_input_tokens: 5,
              }
            : { input_tokens: 20, output_tokens: 5 },
      },
    },
  ];
}
