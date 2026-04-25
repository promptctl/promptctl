import { describe, expect, it } from "vitest";
import type {
  AnthropicUsage,
  RequestRecord,
} from "../../../shared/proxy-events";
import { cacheRatio, formatToken, sumUsage, usageShares } from "./usage";

describe("usage helpers", () => {
  it("returns null when no record has usage", () => {
    expect(sumUsage([])).toBeNull();
    expect(sumUsage([record(null)])).toBeNull();
  });

  it("sums each field and treats missing cache fields as zero", () => {
    expect(
      sumUsage([
        record({
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        }),
        record({
          input_tokens: 1,
          output_tokens: 2,
        }),
      ]),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });
  });

  it("computes cache ratios and handles empty denominators", () => {
    expect(
      cacheRatio({
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 80,
      }),
    ).toBe(0.8);
    expect(cacheRatio(null)).toBeNull();
    expect(cacheRatio({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });

  it("computes cache share segments", () => {
    expect(
      usageShares({
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 80,
      }),
    ).toEqual({
      freshInput: 0.1,
      cacheCreation: 0.1,
      cacheRead: 0.8,
    });
  });

  it("formats tokens compactly", () => {
    expect(formatToken(null)).toBe("…");
    expect(formatToken(undefined)).toBe("…");
    expect(formatToken(0)).toBe("0");
    expect(formatToken(567)).toBe("567");
    expect(formatToken(1234)).toBe("1.2k");
    expect(formatToken(1_200_000)).toBe("1.2m");
  });
});

function record(usage: AnthropicUsage | null): RequestRecord {
  return {
    requestId: "req",
    clientId: "client",
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: null,
    startedNs: 1,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: null,
    assembledResponse:
      usage === null
        ? null
        : {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          },
    error: null,
    state: "complete",
    events: [],
  };
}
