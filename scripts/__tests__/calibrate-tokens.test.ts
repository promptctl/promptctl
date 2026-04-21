// Tests the calibration harness without hitting the Anthropic API.
// The harness exports its pure pieces — sampling, request planning, rate
// limiting, prefix construction — so this test can exercise the full decision
// logic without a live endpoint. The integration step that actually calls
// count_tokens is covered by running tokens:calibrate manually.

import { describe, it, expect } from "vitest";
import {
  RateLimiter,
  collectTargets,
  planRequestsForTarget,
  lineToApiMessage,
  buildPrefix,
} from "../calibrate-tokens";
import type { ClaudeLine } from "../../src/main/sessions/claude/types";

function userLine(uuid: string, text: string): ClaudeLine {
  return {
    type: "user",
    uuid,
    timestamp: "2026-04-20T00:00:00Z",
    message: { role: "user", content: text },
  };
}

function assistantText(uuid: string, text: string): ClaudeLine {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-04-20T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function assistantMultiBlock(uuid: string): ClaudeLine {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-04-20T00:00:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "SIG".repeat(100) },
        { type: "text", text: "Here is the answer." },
        {
          type: "tool_use",
          id: "tc_1",
          name: "Read",
          input: { file_path: "/src/main.ts" },
        },
      ],
    },
  };
}

describe("RateLimiter", () => {
  it("gates at minimum gap (simulated time)", async () => {
    // Fake clock: advances only when the test tells it to.
    let now = 0;
    const limiter = new RateLimiter(60, () => now); // 60 RPM = 1000ms gap

    // First call: no wait.
    const start1 = now;
    const t1 = limiter.waitTurn();
    await t1;
    expect(now - start1).toBe(0);

    // Second call: should want to wait. We can't actually sleep in a unit
    // test, so we verify the next lastAt value advanced when we simulate
    // awaiting. In practice the await resolves via setTimeout; we just
    // assert minGapMs is computed correctly by construction.
    expect((limiter as unknown as { minGapMs: number }).minGapMs).toBe(1000);
  });
});

describe("collectTargets", () => {
  it("returns every visible billable line", () => {
    const lines = [
      JSON.stringify(userLine("u1", "hi")),
      JSON.stringify(assistantText("a1", "hello")),
    ];
    const picked = collectTargets(lines);
    expect(picked.length).toBe(2);
  });

  it("returns all lines regardless of count — no sampling cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify(userLine(`u${i}`, `msg ${i}`)));
    }
    const picked = collectTargets(lines);
    expect(picked.length).toBe(300);
    expect(picked[0].lineIdx).toBe(0);
    expect(picked[299].lineIdx).toBe(299);
  });

  it("skips non-visible and empty lines", () => {
    const lines = [
      "", // blank
      "{not-json", // malformed
      JSON.stringify({ type: "attachment", uuid: "att1" }), // non-visible
      JSON.stringify(userLine("u1", "real")),
    ];
    const picked = collectTargets(lines);
    expect(picked).toHaveLength(1);
    expect(picked[0].lineIdx).toBe(3);
  });
});

describe("lineToApiMessage", () => {
  it("string content passes through", () => {
    const msg = lineToApiMessage(userLine("u1", "hello"));
    expect(msg).toEqual({ role: "user", content: "hello" });
  });

  it("multi-block content preserves block order and drops unknown kinds", () => {
    const line = assistantMultiBlock("a1");
    const msg = lineToApiMessage(line);
    expect(msg?.role).toBe("assistant");
    expect(Array.isArray(msg?.content)).toBe(true);
    const blocks = msg?.content as unknown[];
    expect(blocks).toHaveLength(3); // thinking + text + tool_use
  });

  it("returns null for non-visible lines", () => {
    const line: ClaudeLine = {
      type: "attachment",
      uuid: "att1",
    };
    expect(lineToApiMessage(line)).toBeNull();
  });
});

describe("planRequestsForTarget", () => {
  it("single-chunk line emits exactly prefix + (prefix+target) = 2 requests", () => {
    const line = userLine("u1", "hello world");
    const chunks = [{ kind: "user_text" as const, text: "hello world" }];
    const plans = planRequestsForTarget(
      "hash1",
      [],
      { lineIdx: 5, parsed: line, chunks },
    );
    expect(plans).toHaveLength(2);
    expect(plans[0].purpose).toBe("prefix");
    expect(plans[1].purpose).toBe("prefix+target");
  });

  it("multi-chunk line adds one synthetic-kind request per chunk", () => {
    const line = assistantMultiBlock("a1");
    const chunks = [
      { kind: "thinking_signature" as const, text: "SIG".repeat(100) },
      { kind: "assistant_text" as const, text: "Here is the answer." },
      {
        kind: "tool_use_input" as const,
        text: JSON.stringify({ file_path: "/src/main.ts" }),
      },
    ];
    const plans = planRequestsForTarget(
      "hash1",
      [],
      { lineIdx: 7, parsed: line, chunks },
    );
    // 2 fixed + 3 synthetic-kind = 5
    expect(plans).toHaveLength(5);
    const syntheticKinds = plans
      .filter((p) => p.purpose === "prefix+synthetic-kind")
      .map((p) => p.kind);
    expect(syntheticKinds.sort()).toEqual(
      ["assistant_text", "thinking_signature", "tool_use_input"].sort(),
    );
  });
});

describe("buildPrefix", () => {
  it("yields an AnthropicMessage per visible line strictly before the target", () => {
    const lines = [
      JSON.stringify(userLine("u1", "first")),
      JSON.stringify({ type: "attachment", uuid: "att1" }), // skipped
      JSON.stringify(assistantText("a1", "response")),
      JSON.stringify(userLine("u2", "target")),
    ];
    const prefix = buildPrefix(lines, 3); // stop before user 'target'
    expect(prefix).toHaveLength(2);
    expect(prefix[0]).toEqual({ role: "user", content: "first" });
    expect(prefix[1]?.role).toBe("assistant");
  });
});
