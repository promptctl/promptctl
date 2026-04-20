import { describe, it, expect } from "vitest";
import { stableStringify } from "../core/stable-stringify";

describe("stableStringify", () => {
  it("sorts object keys at every depth", () => {
    const input = { b: 1, a: { z: 1, y: 2 }, c: [{ q: 1, p: 2 }] };
    const out = stableStringify(input, 0);
    expect(out).toBe('{"a":{"y":2,"z":1},"b":1,"c":[{"p":2,"q":1}]}\n');
  });

  it("preserves array order (arrays are ordered data)", () => {
    const input = { arr: [3, 1, 2] };
    expect(stableStringify(input, 0)).toBe('{"arr":[3,1,2]}\n');
  });

  it("is idempotent on the same input", () => {
    const input = { x: [1, { c: 3, a: 1, b: 2 }] };
    expect(stableStringify(input)).toBe(stableStringify(input));
  });

  it("ends output with a single newline", () => {
    const out = stableStringify({ a: 1 });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
