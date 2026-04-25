import { describe, expect, it } from "vitest";
import type {
  AnthropicUsage,
  RequestRecord,
} from "../../../shared/proxy-events";
import { computeLineage } from "./lineage";

describe("computeLineage", () => {
  it("links a 3-request chain and isolates an unrelated parallel request", () => {
    const a = req("a", "client-1", 1_000, 2_000, [user("hi")]);
    const b = req("b", "client-1", 3_000, 4_000, [
      user("hi"),
      assistant("hello"),
      user("more"),
    ]);
    const c = req("c", "client-1", 5_000, 6_000, [
      user("hi"),
      assistant("hello"),
      user("more"),
      assistant("ok"),
      user("again"),
    ]);
    const x = req("x", "client-1", 4_500, 5_500, [user("unrelated")]);

    const lineage = computeLineage([a, b, c, x]);

    expect(lineage.get("a")).toMatchObject({
      parentId: null,
      rootId: "a",
      depth: 0,
    });
    expect(lineage.get("b")).toMatchObject({
      parentId: "a",
      rootId: "a",
      depth: 1,
    });
    expect(lineage.get("c")).toMatchObject({
      parentId: "b",
      rootId: "a",
      depth: 2,
    });
    expect(lineage.get("x")).toMatchObject({ parentId: null, rootId: "x" });
  });

  it("returns only the new messages for continuations", () => {
    const a = req("a", "c1", 1, 2, [user("hi")]);
    const b = req("b", "c1", 3, 4, [
      user("hi"),
      assistant("hello"),
      user("more"),
    ]);

    const lineage = computeLineage([a, b]);

    expect(lineage.get("a")?.newMessages).toEqual([user("hi")]);
    expect(lineage.get("b")?.newMessages).toEqual([
      assistant("hello"),
      user("more"),
    ]);
  });

  it("does not link across clients", () => {
    const a = req("a", "c1", 1, 2, [user("hi")]);
    const b = req("b", "c2", 3, 4, [user("hi"), assistant("hi"), user("yo")]);
    const lineage = computeLineage([a, b]);
    expect(lineage.get("b")?.parentId).toBeNull();
  });

  it("does not link across models", () => {
    const a = req("a", "c1", 1, 2, [user("hi")], "claude-a");
    const b = req(
      "b",
      "c1",
      3,
      4,
      [user("hi"), assistant("hi"), user("yo")],
      "claude-b",
    );
    const lineage = computeLineage([a, b]);
    expect(lineage.get("b")?.parentId).toBeNull();
  });

  it("does not link beyond the 5-minute window", () => {
    const completedNs = 1 + 60 * 1_000_000_000;
    const a = req("a", "c1", 1, completedNs, [user("hi")]);
    const farLater = completedNs + 6 * 60 * 1_000_000_000;
    const b = req("b", "c1", farLater, farLater + 1, [
      user("hi"),
      assistant("hi"),
      user("yo"),
    ]);
    const lineage = computeLineage([a, b]);
    expect(lineage.get("b")?.parentId).toBeNull();
  });

  it("records parent's billable token sum as expected cache tokens", () => {
    const a = req(
      "a",
      "c1",
      1,
      2,
      [user("hi")],
      "claude-test",
      usage(10, 5, 7, 3),
    );
    const b = req("b", "c1", 3, 4, [user("hi"), assistant("hi"), user("yo")]);
    const lineage = computeLineage([a, b]);
    expect(lineage.get("b")?.expectedCacheTokens).toBe(25);
  });

  it("ignores requests without messages", () => {
    const a = { ...req("a", "c1", 1, 2, [user("hi")]), requestBody: null };
    const b = req("b", "c1", 3, 4, [user("hi"), assistant("hi"), user("yo")]);
    const lineage = computeLineage([a, b]);
    expect(lineage.get("a")?.parentId).toBeNull();
    expect(lineage.get("b")?.parentId).toBeNull();
  });
});

function user(text: string): unknown {
  return { role: "user", content: text };
}
function assistant(text: string): unknown {
  return { role: "assistant", content: text };
}

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
): AnthropicUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function req(
  id: string,
  clientId: string,
  startedNs: number,
  completedNs: number | null,
  messages: unknown[],
  model = "claude-test",
  usageOut: AnthropicUsage | null = { input_tokens: 1, output_tokens: 1 },
): RequestRecord {
  return {
    requestId: id,
    clientId,
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: 200,
    startedNs,
    firstByteNs: startedNs + 1,
    completedNs,
    endedNs: completedNs,
    requestBody: { model, messages },
    assembledResponse:
      usageOut === null
        ? null
        : {
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: usageOut,
          },
    error: null,
    state: "complete",
    events: [],
  };
}
