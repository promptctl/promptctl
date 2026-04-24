// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseLsofPid } from "./client-identity";

describe("client identity", () => {
  it("parses lsof field output into a pid", () => {
    expect(parseLsofPid("p12345\nn127.0.0.1:54321\n")).toBe(12345);
  });

  it("returns null when lsof has no process field", () => {
    expect(parseLsofPid("n127.0.0.1:54321\n")).toBeNull();
  });
});
