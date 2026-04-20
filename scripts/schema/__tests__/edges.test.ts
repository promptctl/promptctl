import { describe, it, expect } from "vitest";
import {
  verifyDeclaredEdges,
  suggestEdges,
  indexValue,
  type DeclaredEdge,
  type ValueIndex,
} from "../core/edges";

describe("verifyDeclaredEdges", () => {
  it("counts resolved vs orphaned references", () => {
    const edges: DeclaredEdge[] = [
      { from: "A.parent", to: "A.id", note: "" },
    ];
    const fromValues = new Map<string, string[]>([
      ["A.parent", ["u1", "u2", "u3", "missing"]],
    ]);
    const toIndex: ValueIndex = new Map([
      ["A.id", new Set(["u1", "u2", "u3"])],
    ]);
    const [result] = verifyDeclaredEdges(edges, fromValues, toIndex);
    expect(result.fromCount).toBe(4);
    expect(result.resolvedCount).toBe(3);
    expect(result.orphanRate).toBeCloseTo(0.25, 4);
    expect(result.source).toBe("declared");
  });

  it("handles empty from set without division-by-zero", () => {
    const edges: DeclaredEdge[] = [{ from: "A.x", to: "B.y", note: "" }];
    const [result] = verifyDeclaredEdges(edges, new Map(), new Map());
    expect(result.fromCount).toBe(0);
    expect(result.resolvedCount).toBe(0);
    expect(result.orphanRate).toBe(0);
  });
});

describe("suggestEdges", () => {
  it("promotes high-overlap string field pairs not already declared", () => {
    const idx: ValueIndex = new Map();
    for (let i = 0; i < 100; i++) {
      indexValue(idx, "A.ref", `v${i}`);
      indexValue(idx, "B.id", `v${i}`);
    }
    const suggestions = suggestEdges(idx, [], { minCardinality: 10 });
    expect(suggestions.some((s) => s.from === "A.ref" && s.to === "B.id")).toBe(true);
  });

  it("excludes declared edges from suggestions", () => {
    const idx: ValueIndex = new Map();
    for (let i = 0; i < 100; i++) {
      indexValue(idx, "A.ref", `v${i}`);
      indexValue(idx, "B.id", `v${i}`);
    }
    const declared: DeclaredEdge[] = [
      { from: "A.ref", to: "B.id", note: "" },
    ];
    const suggestions = suggestEdges(idx, declared, { minCardinality: 10 });
    expect(suggestions.some((s) => s.from === "A.ref" && s.to === "B.id")).toBe(false);
  });

  it("skips low-cardinality fields", () => {
    const idx: ValueIndex = new Map();
    indexValue(idx, "A.x", "only-one");
    indexValue(idx, "B.y", "only-one");
    const suggestions = suggestEdges(idx, [], { minCardinality: 10 });
    expect(suggestions).toEqual([]);
  });
});
