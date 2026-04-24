// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseLsofEntries, parseLsofPid, parseLsofPids } from "./client-identity";

describe("client identity", () => {
  it("parses lsof field output into a pid", () => {
    expect(parseLsofPid("p12345\nn127.0.0.1:54321\n")).toBe(12345);
  });

  it("returns null when lsof has no process field", () => {
    expect(parseLsofPid("n127.0.0.1:54321\n")).toBeNull();
  });

  it("parses all lsof process fields in output order", () => {
    expect(parseLsofPids("p111\nnA\np222\nnB\n")).toEqual([111, 222]);
  });

  it("parses lsof pid/name pairs", () => {
    expect(parseLsofEntries("p111\nn127.0.0.1:1->127.0.0.1:2\np222\nnB\n")).toEqual([
      { pid: 111, name: "127.0.0.1:1->127.0.0.1:2" },
      { pid: 222, name: "B" },
    ]);
  });
});
