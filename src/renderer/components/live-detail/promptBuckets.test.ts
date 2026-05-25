// [LAW:behavior-not-structure] Tests describe the projection's output
// shape and ordering rules — not the internal accumulator. Refactoring
// from Map-based to array-based aggregation would be transparent here.

import { describe, expect, it } from "vitest";
import {
  bucketBySystemPrompt,
  systemPreview,
  toolNames,
} from "./promptBuckets";
import type { RequestRecord } from "../../../shared/proxy-events";

function req(
  partial: Partial<RequestRecord> & {
    requestId: string;
    requestBody?: unknown;
  },
): RequestRecord {
  return {
    requestId: partial.requestId,
    clientId: partial.clientId ?? "client-1",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    startedNs: partial.startedNs ?? 0,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: partial.requestBody ?? null,
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
  };
}

describe("bucketBySystemPrompt", () => {
  it("returns an empty list when no requests have a system prompt", () => {
    expect(
      bucketBySystemPrompt([req({ requestId: "r1", requestBody: {} })]),
    ).toEqual([]);
  });

  it("clusters: 3 requests with 2 distinct prompts → 2 buckets", () => {
    const buckets = bucketBySystemPrompt([
      req({ requestId: "r1", requestBody: { system: "A" }, startedNs: 1 }),
      req({ requestId: "r2", requestBody: { system: "A" }, startedNs: 2 }),
      req({ requestId: "r3", requestBody: { system: "B" }, startedNs: 3 }),
    ]);
    expect(buckets).toHaveLength(2);
    const a = buckets.find((b) => b.sampleSystem === "A");
    const b = buckets.find((b) => b.sampleSystem === "B");
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
    expect(a?.requestIds).toEqual(["r1", "r2"]);
  });

  it("sorts buckets by lastSeenNs descending (most-recent first)", () => {
    const buckets = bucketBySystemPrompt([
      req({ requestId: "r1", requestBody: { system: "A" }, startedNs: 10 }),
      req({ requestId: "r2", requestBody: { system: "B" }, startedNs: 20 }),
      req({ requestId: "r3", requestBody: { system: "C" }, startedNs: 5 }),
    ]);
    expect(buckets.map((b) => b.sampleSystem)).toEqual(["B", "A", "C"]);
  });

  it("aggregates clientIds across the bucket", () => {
    const buckets = bucketBySystemPrompt([
      req({
        requestId: "r1",
        clientId: "client-a",
        requestBody: { system: "S" },
        startedNs: 1,
      }),
      req({
        requestId: "r2",
        clientId: "client-b",
        requestBody: { system: "S" },
        startedNs: 2,
      }),
      req({
        requestId: "r3",
        clientId: "client-a",
        requestBody: { system: "S" },
        startedNs: 3,
      }),
    ]);
    expect(buckets).toHaveLength(1);
    expect([...buckets[0].clientIds].sort()).toEqual(["client-a", "client-b"]);
  });

  it("displays tools from the most-recent request in the bucket", () => {
    const oldTools = [{ name: "Bash" }];
    const newTools = [{ name: "Bash" }, { name: "Read" }];
    const buckets = bucketBySystemPrompt([
      req({
        requestId: "old",
        requestBody: { system: "S", tools: oldTools },
        startedNs: 1,
      }),
      req({
        requestId: "new",
        requestBody: { system: "S", tools: newTools },
        startedNs: 2,
      }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].sampleTools).toEqual(newTools);
  });

  it("skips requests with no system prompt without erroring", () => {
    const buckets = bucketBySystemPrompt([
      req({ requestId: "no-sys", requestBody: { messages: [] }, startedNs: 1 }),
      req({ requestId: "yes-sys", requestBody: { system: "S" }, startedNs: 2 }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].requestIds).toEqual(["yes-sys"]);
  });
});

describe("systemPreview", () => {
  it("returns the trimmed string for string-form prompts", () => {
    expect(systemPreview("  hello  ")).toBe("hello");
  });

  it("joins block-form prompts with newlines", () => {
    expect(
      systemPreview([
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two" },
      ]),
    ).toBe("Line one\nLine two");
  });

  it("truncates long previews with an ellipsis", () => {
    const long = "x".repeat(300);
    const preview = systemPreview(long, 50);
    expect(preview.length).toBe(51); // 50 chars + ellipsis
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("toolNames", () => {
  it("returns names from tool objects", () => {
    expect(toolNames([{ name: "Bash" }, { name: "Read" }])).toEqual([
      "Bash",
      "Read",
    ]);
  });

  it("returns empty for null tools", () => {
    expect(toolNames(null)).toEqual([]);
  });

  it("skips tool entries with no string name", () => {
    expect(toolNames([{ name: "Bash" }, { description: "no name" }])).toEqual([
      "Bash",
    ]);
  });
});
