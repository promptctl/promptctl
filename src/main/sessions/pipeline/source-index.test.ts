import { describe, expect, it } from "vitest";
import { buildSourceIndexToUuid, targetUuidsForStep } from "./source-index";

const VISIBLE_USER = (uuid: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "x" },
  });

const VISIBLE_ASSISTANT = (uuid: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "x" }],
    },
  });

const HIDDEN_SIDECHAIN = (uuid: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    isSidechain: true,
    cwd: "/r",
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "x" },
  });

describe("buildSourceIndexToUuid", () => {
  it("maps source-logical indices to uuids, ignoring non-visible lines", () => {
    const content = [
      VISIBLE_USER("u1"),
      HIDDEN_SIDECHAIN("hidden-1"),
      VISIBLE_ASSISTANT("a1"),
      VISIBLE_USER("u2"),
    ].join("\n");
    const map = buildSourceIndexToUuid(content);
    expect(map.get(0)).toBe("u1");
    expect(map.get(1)).toBe("a1");
    expect(map.get(2)).toBe("u2");
    expect(map.size).toBe(3);
  });

  it("skips malformed JSON without throwing", () => {
    const content = [VISIBLE_USER("u1"), "{not json", VISIBLE_USER("u2")].join(
      "\n",
    );
    const map = buildSourceIndexToUuid(content);
    expect(map.get(0)).toBe("u1");
    expect(map.get(1)).toBe("u2");
  });
});

describe("targetUuidsForStep", () => {
  it("resolves indices to uuids; unknown indices are dropped", () => {
    const content = [VISIBLE_USER("u1"), VISIBLE_USER("u2")].join("\n");
    const uuids = targetUuidsForStep(content, [0, 999]);
    expect([...uuids]).toEqual(["u1"]);
  });
});
