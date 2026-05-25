import { describe, expect, it } from "vitest";
import type {
  AnthropicMessage,
  RequestRecord,
} from "../../../shared/proxy-events";
import {
  emptyFilters,
  filtersAreEmpty,
  hasToolUseOf,
  isErrorOf,
  modelOf,
  observedModels,
  passesFilters,
  sizeBucketOf,
  statusOf,
  type RequestFilters,
} from "./filters";

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: "r",
    clientId: "c",
    method: "POST",
    url: "https://api.example.test/r",
    status: 200,
    startedNs: 0,
    firstByteNs: 1,
    completedNs: 2,
    endedNs: 2,
    requestBody: { model: "claude-test", messages: [] },
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
    ...overrides,
  };
}

function withResponse(content: AnthropicMessage["content"]): AnthropicMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("filter extractors", () => {
  it("modelOf reads requestBody.model when present", () => {
    expect(modelOf(record())).toBe("claude-test");
    expect(modelOf(record({ requestBody: null }))).toBeNull();
    expect(modelOf(record({ requestBody: { model: 42 } }))).toBeNull();
    expect(modelOf(record({ requestBody: { model: "" } }))).toBeNull();
  });

  it("statusOf bucketizes state + http status + error string", () => {
    expect(statusOf(record({ state: "complete", status: 200 }))).toBe("success");
    expect(statusOf(record({ state: "in_flight", status: null }))).toBe(
      "pending",
    );
    expect(statusOf(record({ state: "streaming", status: 200 }))).toBe(
      "pending",
    );
    expect(statusOf(record({ state: "errored", error: "boom" }))).toBe("error");
    // 4xx without errored state still counts as error — upstream failures
    // bypass the proxy_error path but should not look like success.
    expect(statusOf(record({ state: "complete", status: 429 }))).toBe("error");
    expect(statusOf(record({ state: "complete", status: 500 }))).toBe("error");
  });

  it("hasToolUseOf inspects assembledResponse.content for tool_use blocks", () => {
    expect(hasToolUseOf(record({ assembledResponse: null }))).toBe("no");
    expect(
      hasToolUseOf(
        record({ assembledResponse: withResponse([{ type: "text", text: "hi" }]) }),
      ),
    ).toBe("no");
    expect(
      hasToolUseOf(
        record({
          assembledResponse: withResponse([
            { type: "text", text: "calling" },
            { type: "tool_use", id: "tu1", name: "Bash", input: {} },
          ]),
        }),
      ),
    ).toBe("yes");
  });

  it("isErrorOf mirrors statusOf === error", () => {
    expect(isErrorOf(record({ state: "errored", error: "x" }))).toBe("yes");
    expect(isErrorOf(record({ state: "complete", status: 200 }))).toBe("no");
    expect(isErrorOf(record({ state: "in_flight", status: null }))).toBe("no");
  });

  it("sizeBucketOf bucketizes JSON-stringified request body length", () => {
    expect(sizeBucketOf(record({ requestBody: null }))).toBe("small");
    expect(sizeBucketOf(record({ requestBody: { model: "x" } }))).toBe("small");
    // Push past 4KB into medium.
    const medium = { model: "x", payload: "y".repeat(5_000) };
    expect(sizeBucketOf(record({ requestBody: medium }))).toBe("medium");
    // Push past 64KB into large.
    const large = { model: "x", payload: "y".repeat(70_000) };
    expect(sizeBucketOf(record({ requestBody: large }))).toBe("large");
  });

  it("observedModels deduplicates in first-seen order", () => {
    const records = [
      record({ requestBody: { model: "claude-sonnet" } }),
      record({ requestBody: { model: "claude-opus" } }),
      record({ requestBody: { model: "claude-sonnet" } }),
      record({ requestBody: null }),
    ];
    expect(observedModels(records)).toEqual(["claude-sonnet", "claude-opus"]);
  });
});

describe("passesFilters composition", () => {
  function filters(overrides: Partial<RequestFilters> = {}): RequestFilters {
    return { ...emptyFilters(), ...overrides };
  }

  it("empty filters pass every record (identity for AND composition)", () => {
    expect(passesFilters(record(), emptyFilters())).toBe(true);
    expect(
      passesFilters(record({ state: "errored", error: "x" }), emptyFilters()),
    ).toBe(true);
    expect(filtersAreEmpty(emptyFilters())).toBe(true);
  });

  it("populated set requires the extracted value to match", () => {
    const f = filters({ models: new Set(["claude-sonnet"]) });
    expect(passesFilters(record({ requestBody: { model: "claude-sonnet" } }), f))
      .toBe(true);
    expect(passesFilters(record({ requestBody: { model: "claude-opus" } }), f))
      .toBe(false);
    // null extraction can never satisfy a non-empty constraint.
    expect(passesFilters(record({ requestBody: null }), f)).toBe(false);
  });

  it("multi-value set is OR within the category", () => {
    const f = filters({ statuses: new Set(["success", "error"]) });
    expect(passesFilters(record({ state: "complete", status: 200 }), f)).toBe(
      true,
    );
    expect(passesFilters(record({ state: "errored", error: "x" }), f)).toBe(
      true,
    );
    expect(passesFilters(record({ state: "in_flight", status: null }), f)).toBe(
      false,
    );
  });

  it("multiple non-empty categories AND together", () => {
    const f = filters({
      models: new Set(["claude-sonnet"]),
      errors: new Set(["yes"]),
    });
    expect(
      passesFilters(
        record({
          requestBody: { model: "claude-sonnet" },
          state: "errored",
          error: "x",
        }),
        f,
      ),
    ).toBe(true);
    // Model matches but no error → AND fails.
    expect(
      passesFilters(
        record({
          requestBody: { model: "claude-sonnet" },
          state: "complete",
          status: 200,
        }),
        f,
      ),
    ).toBe(false);
    // Error matches but wrong model → AND fails.
    expect(
      passesFilters(
        record({
          requestBody: { model: "claude-opus" },
          state: "errored",
          error: "x",
        }),
        f,
      ),
    ).toBe(false);
  });

  it("tool-use and size filters compose against the same record", () => {
    const f = filters({
      toolUse: new Set(["yes"]),
      sizeBuckets: new Set(["medium"]),
    });
    const big = {
      model: "claude-sonnet",
      payload: "y".repeat(5_000),
    };
    const r = record({
      requestBody: big,
      assembledResponse: withResponse([
        { type: "tool_use", id: "tu1", name: "Bash", input: {} },
      ]),
    });
    expect(passesFilters(r, f)).toBe(true);
    // Same body, no tool_use → composer rejects.
    expect(
      passesFilters(
        record({
          requestBody: big,
          assembledResponse: withResponse([{ type: "text", text: "hi" }]),
        }),
        f,
      ),
    ).toBe(false);
  });
});
