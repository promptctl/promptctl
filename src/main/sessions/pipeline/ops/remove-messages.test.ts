import { describe, expect, it } from "vitest";
import { removeMessages } from "./remove-messages";
import type { Step } from "../../../../shared/types";

function buildStep(targets: number[]): Step {
  return {
    id: "test-step",
    source: "manual",
    kind: "remove-messages",
    targets,
  };
}

function userLine(uuid: string) {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hi" },
  });
}

describe("removeMessages op", () => {
  it("removes targeted lines and preserves others byte-for-byte", () => {
    const source = [
      userLine("u1"),
      userLine("u2"),
      userLine("u3"),
    ].join("\n");
    const result = removeMessages(source, buildStep([1]), source);
    const remaining = result
      .split("\n")
      .map((l) => JSON.parse(l) as { uuid: string });
    expect(remaining.map((l) => l.uuid)).toEqual(["u1", "u3"]);
  });

  it("returns content unchanged when no targets resolve", () => {
    const source = userLine("u1");
    const result = removeMessages(source, buildStep([99]), source);
    expect(result).toBe(source);
  });
});
