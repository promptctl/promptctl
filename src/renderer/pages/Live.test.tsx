import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Live } from "./Live";
import { useProxyStore } from "../store/proxy";
import type { ClientInfo, ProxyEvent } from "../../shared/proxy-events";

beforeEach(() => {
  cleanup();
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
  it("renders grouped request rows, client tabs, filtering, and expansion", async () => {
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    state.upsertClient(client("client-b", "Codex @ app"));
    for (const event of [...events("req-a", "client-a"), ...events("req-b", "client-b")]) {
      useProxyStore.getState().appendEvent(event);
    }

    render(<Live />);

    expect(screen.getByText("Claude @ app")).toBeTruthy();
    expect(screen.getByText("Codex @ app")).toBeTruthy();
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/req-b/).length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByText("Claude @ app"));
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/req-b/)).toBeNull();

    await user.click(screen.getAllByText(/req-a/)[0]);
    expect(screen.getByText("request_headers")).toBeTruthy();
    expect(screen.getByText("response_complete")).toBeTruthy();
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
      kind: "response_complete",
      body: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}
