import { describe, it, expect } from "vitest";
import { parseCron, nextCronOccurrence } from "./cron";

describe("parseCron", () => {
  it("parses simple wildcard", () => {
    const expr = parseCron("* * * * *");
    expect(expr.minutes).toHaveLength(60);
    expect(expr.hours).toHaveLength(24);
  });

  it("parses step values", () => {
    const expr = parseCron("*/5 * * * *");
    expect(expr.minutes).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it("parses ranges", () => {
    const expr = parseCron("0 9-17 * * *");
    expect(expr.minutes).toEqual([0]);
    expect(expr.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("parses lists", () => {
    const expr = parseCron("0 9,12,17 * * *");
    expect(expr.hours).toEqual([9, 12, 17]);
  });

  it("parses day of week", () => {
    const expr = parseCron("0 9 * * 1-5");
    expect(expr.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws on invalid expression", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields");
  });
});

describe("nextCronOccurrence", () => {
  it("finds next occurrence for every-5-minutes", () => {
    const expr = parseCron("*/5 * * * *");
    const after = new Date("2026-03-22T10:03:00");
    const next = nextCronOccurrence(expr, after);
    expect(next.getMinutes()).toBe(5);
    expect(next.getHours()).toBe(10);
  });

  it("finds next occurrence for specific hour", () => {
    const expr = parseCron("0 14 * * *");
    const after = new Date("2026-03-22T15:00:00");
    const next = nextCronOccurrence(expr, after);
    expect(next.getHours()).toBe(14);
    expect(next.getDate()).toBe(23); // next day
  });
});
