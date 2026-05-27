import { describe, expect, it } from "vitest";
import { buildPipelineEffectMap } from "./PipelinePanel";
import type { Step } from "../../shared/types";

const makeStep = (
  kind: "strip-thinking" | "remove-messages",
  targets: number[],
): Step => ({
  id: `${kind}-id`,
  source: "test",
  kind,
  targets,
});

describe("buildPipelineEffectMap", () => {
  it("returns empty map for empty pipeline", () => {
    expect(buildPipelineEffectMap([]).size).toBe(0);
  });

  it("maps each target index to the step kinds that target it", () => {
    const map = buildPipelineEffectMap([
      makeStep("strip-thinking", [1, 3, 5]),
      makeStep("remove-messages", [3, 7]),
    ]);
    expect(map.get(1)).toEqual(["strip-thinking"]);
    expect(map.get(3)).toEqual(["strip-thinking", "remove-messages"]);
    expect(map.get(5)).toEqual(["strip-thinking"]);
    expect(map.get(7)).toEqual(["remove-messages"]);
    expect(map.get(99)).toBeUndefined();
  });

  it("dedupes duplicate target indices within a single step", () => {
    // Ops dedupe via UUID Set, so the UI must match — one step
    // contributes at most one badge per message index.
    const map = buildPipelineEffectMap([
      makeStep("strip-thinking", [1, 1, 1, 2]),
    ]);
    expect(map.get(1)).toEqual(["strip-thinking"]);
    expect(map.get(2)).toEqual(["strip-thinking"]);
  });

  it("preserves step order when multiple steps target the same index", () => {
    // Step order = pipeline order; the badge list should reflect that.
    const map = buildPipelineEffectMap([
      makeStep("remove-messages", [0]),
      makeStep("strip-thinking", [0]),
    ]);
    expect(map.get(0)).toEqual(["remove-messages", "strip-thinking"]);
  });
});
