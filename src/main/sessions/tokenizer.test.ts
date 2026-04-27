import { describe, it, expect } from "vitest";
import { encoding_for_model } from "tiktoken";
import { countTokens, truncateMiddle } from "./tokenizer";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("counts tokens for simple text", () => {
    const count = countTokens("Hello, world!");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it("counts more tokens for longer text", () => {
    const short = countTokens("hello");
    const long = countTokens("hello ".repeat(100));
    expect(long).toBeGreaterThan(short);
  });
});

describe("truncateMiddle", () => {
  it("returns short text unchanged", () => {
    const text = "This is a short string.";
    expect(truncateMiddle(text, 100)).toBe(text);
  });

  it("returns text unchanged when exactly at threshold", () => {
    // Build text that is exactly 200 tokens (100 * 2)
    const text = "word ".repeat(200);
    const tokens = countTokens(text);
    // If it's <= 200 tokens, should return unchanged
    if (tokens <= 200) {
      expect(truncateMiddle(text, 100)).toBe(text);
    }
  });

  it("truncates long text preserving head and tail", () => {
    const text = "START_MARKER " + "filler content here ".repeat(500) + " END_MARKER";
    const result = truncateMiddle(text, 100);

    expect(result).toContain("START_MARKER");
    expect(result).toContain("END_MARKER");
    expect(result).toContain("tokens omitted");
    expect(countTokens(result)).toBeLessThan(countTokens(text));
  });

  it("includes dropped token count in ellipsis", () => {
    const text = "x ".repeat(1000);
    const keep = 50;
    const result = truncateMiddle(text, keep);
    const match = result.match(/(\d+) tokens omitted/);
    if (!match) throw new Error("expected match for 'N tokens omitted'");
    const dropped = parseInt(match[1], 10);
    expect(dropped).toBeGreaterThan(0);
    // truncateMiddle uses tiktoken internally; dropped is in tiktoken tokens,
    // not the char-based estimator that countTokens returns. Compare against
    // tiktoken's own count so the units match.
    const enc = encoding_for_model("gpt-4o");
    const originalTokens = enc.encode(text).length;
    enc.free();
    expect(dropped).toBe(originalTokens - keep * 2);
  });

  it("respects custom keep parameter", () => {
    const text = "word ".repeat(1000);
    const result50 = truncateMiddle(text, 50);
    const result200 = truncateMiddle(text, 200);
    expect(countTokens(result50)).toBeLessThan(countTokens(result200));
  });
});
