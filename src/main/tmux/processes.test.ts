import { describe, it, expect } from "vitest";
import { parsePsOutput, isRealExecFailure, getPaneProcesses } from "./processes";

describe("parsePsOutput", () => {
  it("parses standard ps output", () => {
    const output = `  3416 88767 node 01:06:13 0:02.47 node --no-warnings /usr/bin/gemini
  3420 88767 ruby 00:30:00 0:01.00 ruby server.rb`;

    const result = parsePsOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(3416);
    expect(result[0].ppid).toBe(88767);
    expect(result[0].comm).toBe("node");
    expect(result[0].elapsed).toBe("01:06:13");
    expect(result[0].cpuTime).toBe("0:02.47");
    expect(result[0].args).toBe("node --no-warnings /usr/bin/gemini");
  });

  it("handles empty output", () => {
    expect(parsePsOutput("")).toHaveLength(0);
    expect(parsePsOutput("   \n  ")).toHaveLength(0);
  });

  it("handles single process", () => {
    const output = "  1234  5678 bash 00:05:00 0:00.10 bash";
    const result = parsePsOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(1234);
    expect(result[0].comm).toBe("bash");
  });
});

describe("isRealExecFailure", () => {
  it("treats success (no error) as not a failure", () => {
    expect(isRealExecFailure(null)).toBe(false);
  });

  it("treats exit code 1 as the empty set, not a failure", () => {
    // The regression: pgrep with no children and ps with an already-exited
    // child both exit 1. That is normal process-tree churn, not an error.
    expect(isRealExecFailure({ code: 1 })).toBe(false);
  });

  it("treats any other exit code as a genuine failure", () => {
    expect(isRealExecFailure({ code: 127 })).toBe(true);
    expect(isRealExecFailure({ code: 2 })).toBe(true);
  });
});

describe("getPaneProcesses", () => {
  it("returns [] for a pane with no children without throwing", async () => {
    // A ppid with no children makes the real `pgrep -P` exit 1 — the empty-set
    // path must resolve [] end-to-end rather than reject. 2147483647 is above
    // any live pid, so it reliably has no children.
    await expect(getPaneProcesses(2147483647)).resolves.toEqual([]);
  });
});
