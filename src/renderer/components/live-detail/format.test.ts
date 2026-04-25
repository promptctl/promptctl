import { describe, expect, it } from "vitest";
import { formatNs, formatRelativeNs, stateClass, tabClass } from "./format";

describe("live detail format helpers", () => {
  it("keeps existing tab, state, and ns formatting", () => {
    expect(tabClass(true)).toBe(
      "rounded bg-neutral-700 px-2 py-0.5 text-neutral-100",
    );
    expect(stateClass("complete")).toBe("text-green-400");
    expect(formatNs(1_000_000)).toBe("+00001ms");
    expect(formatRelativeNs(16_000_000, 1_000_000)).toBe("+15.0ms");
  });
});
