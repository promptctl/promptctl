import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHistory,
  getHistory,
  recordHistory,
} from "./composer-history";

beforeEach(() => clearHistory());

describe("composer-history", () => {
  it("appends entries in order, oldest first", () => {
    recordHistory("a");
    recordHistory("b");
    recordHistory("c");
    expect(Array.from(getHistory())).toEqual(["a", "b", "c"]);
  });

  it("ignores empty and whitespace-only entries", () => {
    recordHistory("");
    recordHistory("   ");
    recordHistory("\n\n");
    expect(getHistory()).toHaveLength(0);
  });

  it("dedupes consecutive identical entries (trimmed)", () => {
    recordHistory("ls");
    recordHistory("ls");
    recordHistory("  ls  ");
    recordHistory("pwd");
    recordHistory("ls");
    expect(Array.from(getHistory())).toEqual(["ls", "pwd", "ls"]);
  });

  it("caps the ring at 50 entries (FIFO drop)", () => {
    for (let i = 0; i < 60; i++) recordHistory(`cmd-${i}`);
    const ring = Array.from(getHistory());
    expect(ring).toHaveLength(50);
    expect(ring[0]).toBe("cmd-10");
    expect(ring[ring.length - 1]).toBe("cmd-59");
  });

  it("trims surrounding whitespace before recording", () => {
    recordHistory("  hello  ");
    expect(getHistory()[0]).toBe("hello");
  });
});
