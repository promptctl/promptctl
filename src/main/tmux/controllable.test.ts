import { describe, it, expect } from "vitest";
import { isIdle, toolBinary } from "./controllable";
import type { TmuxPane, PaneId, SessionId, WindowId } from "../../shared/types";

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: "%0" as PaneId,
    sessionName: "test",
    sessionId: "$0" as SessionId,
    windowName: "main",
    windowId: "@0" as WindowId,
    windowIndex: 0,
    paneIndex: 0,
    pid: 1000,
    currentCommand: "bash",
    currentPath: "/tmp",
    width: 80,
    height: 24,
    active: true,
    toolKind: "unknown",
    ...overrides,
  };
}

describe("toolBinary", () => {
  it("returns binary for known tools", () => {
    expect(toolBinary("claude")).toBe("claude");
    expect(toolBinary("codex")).toBe("codex");
    expect(toolBinary("gemini")).toBe("gemini");
  });

  it("returns null for unknown", () => {
    expect(toolBinary("unknown")).toBeNull();
  });
});

describe("isIdle", () => {
  it("returns true when running a shell", () => {
    expect(isIdle(makePane({ currentCommand: "bash" }))).toBe(true);
    expect(isIdle(makePane({ currentCommand: "zsh" }))).toBe(true);
    expect(isIdle(makePane({ currentCommand: "fish" }))).toBe(true);
  });

  it("returns false when running a tool", () => {
    expect(isIdle(makePane({ currentCommand: "claude" }))).toBe(false);
    expect(isIdle(makePane({ currentCommand: "node" }))).toBe(false);
  });
});
