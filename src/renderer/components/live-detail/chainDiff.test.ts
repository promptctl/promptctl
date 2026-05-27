import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import {
  buildSystemRuns,
  buildToolsRuns,
  diffSystem,
  diffTools,
} from "./chainDiff";

// Synthetic chain helper. Each entry is `{system, tools}` shorthand;
// requestId is the index, startedNs is monotonic. The clientId / model
// don't matter for chainDiff itself (lineage is computed elsewhere).
function chain(
  steps: { system?: unknown; tools?: unknown[] | null }[],
): RequestRecord[] {
  return steps.map((step, i) => ({
    requestId: `r${i + 1}`,
    clientId: "client-x",
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: 200,
    startedNs: (i + 1) * 1_000,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: {
      model: "claude-test",
      system: step.system,
      tools: step.tools ?? undefined,
      messages: [],
    },
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
  }));
}

describe("buildSystemRuns", () => {
  it("collapses a chain whose system prompt never changes into one run", () => {
    const runs = buildSystemRuns(
      chain([
        { system: "You are Claude." },
        { system: "You are Claude." },
        { system: "You are Claude." },
      ]),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].requestIds).toEqual(["r1", "r2", "r3"]);
    expect(runs[0].firstIntroducedAt).toBe("r1");
    expect(runs[0].value).toBe("You are Claude.");
    expect(runs[0].hash).not.toBeNull();
  });

  it("opens a new run when the system prompt changes once", () => {
    const runs = buildSystemRuns(
      chain([
        { system: "You are Claude." },
        { system: "You are Claude." },
        { system: "You are Claude. You may now call the search tool." },
      ]),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].requestIds).toEqual(["r1", "r2"]);
    expect(runs[1].requestIds).toEqual(["r3"]);
    expect(runs[1].firstIntroducedAt).toBe("r3");
    expect(runs[0].hash).not.toBe(runs[1].hash);
  });

  it("treats a flicker-back to an earlier prompt as a distinct run (AABA → 3 runs)", () => {
    const a = "prompt A";
    const b = "prompt B";
    const runs = buildSystemRuns(
      chain([{ system: a }, { system: a }, { system: b }, { system: a }]),
    );
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.requestIds)).toEqual([
      ["r1", "r2"],
      ["r3"],
      ["r4"],
    ]);
    expect(runs[0].hash).toBe(runs[2].hash);
    expect(runs[1].hash).not.toBe(runs[0].hash);
  });

  it("represents absent system prompts as a real run with null hash", () => {
    const runs = buildSystemRuns(
      chain([{ system: undefined }, { system: undefined }]),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].hash).toBeNull();
    expect(runs[0].requestIds).toEqual(["r1", "r2"]);
  });

  it("treats a transition between absent and present prompts as a distinct run", () => {
    const runs = buildSystemRuns(
      chain([{ system: undefined }, { system: "Hello." }]),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].hash).toBeNull();
    expect(runs[1].hash).not.toBeNull();
  });
});

describe("buildToolsRuns", () => {
  it("opens new runs when tools change twice in a row", () => {
    const t1 = [{ name: "Bash", description: "Run shell" }];
    const t2 = [{ name: "Bash", description: "Run shell" }, { name: "Read" }];
    const t3 = [
      { name: "Bash", description: "Run shell" },
      { name: "Read" },
      { name: "Search" },
    ];
    const runs = buildToolsRuns(
      chain([
        { system: "x", tools: t1 },
        { system: "x", tools: t2 },
        { system: "x", tools: t3 },
      ]),
    );
    expect(runs).toHaveLength(3);
    expect(runs[0].requestIds).toEqual(["r1"]);
    expect(runs[1].requestIds).toEqual(["r2"]);
    expect(runs[2].requestIds).toEqual(["r3"]);
  });

  it("treats an empty tools array as null (matches toolsHash semantics)", () => {
    const runs = buildToolsRuns(
      chain([
        { system: "x", tools: [] },
        { system: "x", tools: null },
      ]),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].hash).toBeNull();
  });

  it("changes runs when system prompt and tools evolve on different requests", () => {
    // The earlier system-changes-once + tools-changes-twice spec, combined.
    const sys1 = "system A";
    const sys2 = "system B";
    const tools1 = [{ name: "Bash" }];
    const tools2 = [{ name: "Bash" }, { name: "Read" }];
    const tools3 = [{ name: "Bash" }, { name: "Read" }, { name: "Write" }];
    const c = chain([
      { system: sys1, tools: tools1 },
      { system: sys1, tools: tools2 },
      { system: sys2, tools: tools2 },
      { system: sys2, tools: tools3 },
    ]);
    const systemRuns = buildSystemRuns(c);
    const toolRuns = buildToolsRuns(c);
    expect(systemRuns).toHaveLength(2);
    expect(toolRuns).toHaveLength(3);
    // System changed at r3 …
    expect(systemRuns[1].firstIntroducedAt).toBe("r3");
    // … tools at r2 and r4.
    expect(toolRuns[1].firstIntroducedAt).toBe("r2");
    expect(toolRuns[2].firstIntroducedAt).toBe("r4");
  });
});

describe("diffSystem", () => {
  it("reports the prompt body as an addition when the from-side is null", () => {
    const result = diffSystem(null, "You are Claude.");
    const added = result.filter((c) => c.kind === "added");
    expect(added.map((c) => c.value).join("")).toContain("You are Claude.");
    expect(result.some((c) => c.kind === "removed")).toBe(false);
  });

  it("reports the prompt body as a removal when the to-side is null", () => {
    const result = diffSystem("You are Claude.", null);
    const removed = result.filter((c) => c.kind === "removed");
    expect(removed.map((c) => c.value).join("")).toContain("You are Claude.");
  });

  it("emits an addition-only chunk for a single appended line", () => {
    const before = "You are Claude.";
    const after = "You are Claude.\nYou may now call the search tool.";
    const result = diffSystem(before, after);
    const added = result.filter((c) => c.kind === "added");
    expect(added.map((c) => c.value).join("")).toContain(
      "You may now call the search tool.",
    );
  });

  it("renders array-form system prompts via fullPromptText so they diff as text", () => {
    const before = [{ type: "text", text: "Line one." }];
    const after = [
      { type: "text", text: "Line one." },
      { type: "text", text: "Line two." },
    ];
    const result = diffSystem(before, after);
    expect(result.some((c) => c.kind === "added" && c.value.includes("Line two."))).toBe(true);
  });
});

describe("diffTools", () => {
  it("partitions tools by name into added / removed / changed", () => {
    const from = [
      { name: "Bash", description: "old desc" },
      { name: "Read", description: "stable" },
      { name: "Removed", description: "gone" },
    ];
    const to = [
      { name: "Bash", description: "new desc" },
      { name: "Read", description: "stable" },
      { name: "New", description: "fresh" },
    ];
    const result = diffTools(from, to);
    expect(result.added.map((t) => t.name)).toEqual(["New"]);
    expect(result.removed.map((t) => t.name)).toEqual(["Removed"]);
    expect(result.changed.map((c) => c.name)).toEqual(["Bash"]);
  });

  it("reports every tool as added when the from-side is null", () => {
    const result = diffTools(null, [{ name: "Bash" }, { name: "Read" }]);
    expect(result.added.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("reports every tool as removed when the to-side is null", () => {
    const result = diffTools([{ name: "Bash" }], null);
    expect(result.removed.map((t) => t.name)).toEqual(["Bash"]);
    expect(result.added).toEqual([]);
  });

  it("produces an empty diff when the tools arrays are deeply equal", () => {
    const tools = [
      { name: "Bash", input_schema: { type: "object" } },
      { name: "Read" },
    ];
    const result = diffTools(tools, tools);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });
});
