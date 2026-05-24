// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaskEvent } from "../../shared/types";

// Electron's webContents is main-process only and unavailable under vitest.
// Mock it so broadcasts go to an in-memory sink we can assert against.
const emitted: TaskEvent[] = [];
vi.mock("electron", () => ({
  webContents: {
    getAllWebContents: () => [
      {
        isDestroyed: () => false,
        send: (_channel: string, payload: TaskEvent) => emitted.push(payload),
      },
    ],
  },
}));

// Import after the mock is wired so runner binds to mocked webContents.
import {
  runTask,
  cancelTask,
  TaskCancelledError,
  __resetTasksForTesting,
} from "./runner";

beforeEach(() => {
  emitted.length = 0;
  __resetTasksForTesting();
});

describe("runTask — happy path", () => {
  it("emits started → progress → done and returns the result", async () => {
    const result = await runTask(
      "t1",
      { kind: "unit", label: "doing a thing", total: 2 },
      async (handle) => {
        handle.reportProgress(1, 2, "halfway");
        handle.reportProgress(2, 2);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    const types = emitted.map((e) => e.type);
    expect(types).toEqual(["started", "progress", "progress", "done"]);
    expect(emitted[0]).toMatchObject({
      type: "started",
      taskId: "t1",
      kind: "unit",
      label: "doing a thing",
      total: 2,
    });
    expect(emitted[1]).toMatchObject({
      type: "progress",
      done: 1,
      total: 2,
      message: "halfway",
    });
  });
});

describe("runTask — cancellation", () => {
  it("cancelTask aborts the signal and runTask emits 'cancelled'", async () => {
    let caught: unknown = null;
    const op = runTask(
      "t2",
      { kind: "unit", label: "long op", total: 10 },
      async (handle) => {
        // Simulate work that checks throwIfCancelled between steps.
        await new Promise((r) => setTimeout(r, 5));
        handle.throwIfCancelled();
        return "unreachable";
      },
    ).catch((e) => {
      caught = e;
    });

    // Cancel before the op wakes up from the timeout.
    cancelTask("t2");
    await op;

    expect(caught).toBeInstanceOf(TaskCancelledError);
    const types = emitted.map((e) => e.type);
    expect(types).toContain("cancelled");
    expect(types).not.toContain("done");
  });

  it("cancelTask returns false for an unknown task id", () => {
    expect(cancelTask("not-a-task")).toBe(false);
  });
});

describe("runTask — errors", () => {
  it("emits 'error' and rethrows when the op throws a non-cancel error", async () => {
    await expect(
      runTask("t3", { kind: "unit", label: "will fail" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const types = emitted.map((e) => e.type);
    expect(types).toEqual(["started", "error"]);
    const errEvt = emitted.find((e) => e.type === "error");
    expect(errEvt && "error" in errEvt ? errEvt.error : "").toBe("boom");
  });
});
