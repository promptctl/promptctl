import { beforeEach, describe, expect, it } from "vitest";
import type { ProxyEvent, RequestRecord } from "../../shared/proxy-events";
import { foldRequests, useProxyStore } from "./proxy";

beforeEach(() => {
  useProxyStore.setState({
    requests: new Map(),
    clients: new Map(),
    selectedClientId: null,
    selectedRequestId: null,
  });
});

describe("proxy store request projection", () => {
  it("folds a request event sequence into one complete RequestRecord", () => {
    const events = requestEvents("req-a", "client-a");
    const records = events.reduce(foldRequests, new Map<string, RequestRecord>());
    const record = records.get("req-a");

    expect(records.size).toBe(1);
    expect(record).toMatchObject({
      requestId: "req-a",
      clientId: "client-a",
      method: "POST",
      status: 200,
      state: "complete",
      error: null,
    });
    expect(record?.events).toHaveLength(events.length);
    expect(record?.assembledResponse?.id).toBe("msg_req-a");
  });

  it("keeps interleaved requestIds as independent records", () => {
    const [a0, a1, a2] = requestEvents("req-a", "client-a");
    const [b0, b1, b2] = requestEvents("req-b", "client-b");
    const records = [a0, b0, a1, b1, a2, b2].reduce(
      foldRequests,
      new Map<string, RequestRecord>(),
    );

    expect(records.size).toBe(2);
    expect(records.get("req-a")?.clientId).toBe("client-a");
    expect(records.get("req-b")?.clientId).toBe("client-b");
    expect(records.get("req-a")?.events.map((e) => e.requestId)).toEqual([
      "req-a",
      "req-a",
      "req-a",
    ]);
  });

  it("updates clients and filters by selected client", () => {
    const store = useProxyStore.getState();
    for (const event of [...requestEvents("req-a", "client-a"), ...requestEvents("req-b", "client-b")]) {
      store.appendEvent(event);
    }
    useProxyStore.getState().selectClient("client-a");

    const state = useProxyStore.getState();
    expect([...state.clients.keys()].sort()).toEqual(["client-a", "client-b"]);
    expect([...state.requests.values()].filter((r) => r.clientId === state.selectedClientId)).toHaveLength(1);
  });
});

function requestEvents(requestId: string, clientId: string): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      seq: 1,
      recvNs: 1,
      kind: "request_headers",
      method: "POST",
      url: `https://example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      seq: 2,
      recvNs: 2,
      kind: "response_headers",
      status: 200,
      headers: {},
    },
    {
      requestId,
      clientId,
      seq: 3,
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
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}
