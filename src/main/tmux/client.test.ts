import { describe, it, expect } from "vitest";
import { parsePaneList, detectToolKind } from "./client";

describe("detectToolKind", () => {
  it("detects claude", () => {
    expect(detectToolKind("claude")).toBe("claude");
    expect(detectToolKind("claude-code")).toBe("claude");
  });

  it("detects codex", () => {
    expect(detectToolKind("codex")).toBe("codex");
  });

  it("detects gemini", () => {
    expect(detectToolKind("gemini")).toBe("gemini");
  });

  it("returns unknown for other commands", () => {
    expect(detectToolKind("bash")).toBe("unknown");
    expect(detectToolKind("vim")).toBe("unknown");
    expect(detectToolKind("node")).toBe("unknown");
  });
});

describe("parsePaneList", () => {
  it("parses tmux list-panes output", () => {
    const input = [
      "%0\twork\t$0\tcode\t@0\t0\t0\t1234\tclaude\t/home/user\t120\t40\t1",
      "%1\twork\t$0\tcode\t@0\t0\t1\t1235\tbash\t/home/user\t120\t40\t0",
    ].join("\n");

    const panes = parsePaneList(input);
    expect(panes).toHaveLength(2);

    expect(panes[0].id).toBe("%0");
    expect(panes[0].sessionName).toBe("work");
    expect(panes[0].sessionId).toBe("$0");
    expect(panes[0].windowName).toBe("code");
    expect(panes[0].windowId).toBe("@0");
    expect(panes[0].windowIndex).toBe(0);
    expect(panes[0].paneIndex).toBe(0);
    expect(panes[0].pid).toBe(1234);
    expect(panes[0].currentCommand).toBe("claude");
    expect(panes[0].currentPath).toBe("/home/user");
    expect(panes[0].width).toBe(120);
    expect(panes[0].height).toBe(40);
    expect(panes[0].active).toBe(true);
    expect(panes[0].toolKind).toBe("claude");

    expect(panes[1].active).toBe(false);
    expect(panes[1].toolKind).toBe("unknown");
  });

  it("handles empty input", () => {
    expect(parsePaneList("")).toHaveLength(0);
    expect(parsePaneList("\n")).toHaveLength(0);
  });
});
