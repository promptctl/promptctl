// @vitest-environment node
//
// Integration tests for getPaneProcesses against the real pgrep binary.
// Hermetic mocking of node:child_process didn't propagate through the
// transitive import in this setup, and dep-injecting the runner would
// bypass the exit-code policy that contains the bug — so the wiring
// is exercised end-to-end here, while the policy itself is unit-tested
// directly in processes.test.ts via isRealExecFailure.

import { describe, it, expect } from "vitest";
import { getPaneProcesses } from "./processes";

describe("getPaneProcesses (real subprocess)", () => {
  it("returns [] for a pane with no children without throwing", async () => {
    // A ppid with no children makes real `pgrep -P` exit 1 — the empty-set
    // path must resolve [] end-to-end rather than reject. 2147483647 is above
    // any live pid, so it reliably has no children. This is the regression
    // test for the loops-pane e2e flake: the IPC handler used to bubble that
    // exit-1 to the renderer as an uncaught error.
    await expect(getPaneProcesses(2147483647)).resolves.toEqual([]);
  });
});
