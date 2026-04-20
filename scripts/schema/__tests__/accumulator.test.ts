import { describe, it, expect } from "vitest";
import { SchemaAccumulator } from "../core/accumulator";

describe("SchemaAccumulator", () => {
  it("counts records and fields, computes presence", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("Line", { type: "a", uuid: "u1" });
    a.observeRecord("Line", { type: "a", uuid: "u2", optional: "x" });
    a.observeRecord("Line", { type: "a" });

    const out = a.finalize();
    const line = out["Line"];
    expect(line.totalCount).toBe(3);
    expect(line.fields?.type.presence).toBe(1);
    expect(line.fields?.uuid.presence).toBeCloseTo(2 / 3, 4);
    expect(line.fields?.optional.presence).toBeCloseTo(1 / 3, 4);
  });

  it("splits records by declared discriminator", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("Line", { type: "user", text: "hi" }, "type");
    a.observeRecord("Line", { type: "assistant", model: "claude" }, "type");
    a.observeRecord("Line", { type: "user", text: "yo" }, "type");

    const out = a.finalize();
    const line = out["Line"];
    expect(line.discriminator).toBe("type");
    expect(line.variants?.user.totalCount).toBe(2);
    expect(line.variants?.assistant.totalCount).toBe(1);
    expect(line.variants?.user.fields?.text.presence).toBe(1);
    expect(line.variants?.assistant.fields?.model.presence).toBe(1);
    expect(line.variants?.user.fields?.model).toBeUndefined();
  });

  it("auto-discriminates array items on a type field", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("Msg", {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Read", input: { path: "/tmp/x" } },
        { type: "text", text: "hello" },
      ],
    });
    const out = a.finalize();
    const content = out["Msg"].fields?.content;
    expect(content?.arrayItem?.discriminator).toBe("type");
    expect(content?.arrayItem?.variants?.text.totalCount).toBe(2);
    expect(content?.arrayItem?.variants?.tool_use.totalCount).toBe(1);
    expect(content?.arrayItem?.variants?.tool_use.fields?.name.presence).toBe(1);
  });

  it("tracks enums when string cardinality is bounded", () => {
    const a = new SchemaAccumulator();
    for (const t of ["a", "b", "a", "c", "b"]) {
      a.observeRecord("L", { status: t });
    }
    const out = a.finalize();
    expect(out["L"].fields?.status.enum).toEqual(["a", "b", "c"]);
  });

  it("drops enum when cardinality exceeds threshold", () => {
    const a = new SchemaAccumulator();
    for (let i = 0; i < 100; i++) a.observeRecord("L", { id: `id-${i}` });
    const out = a.finalize();
    expect(out["L"].fields?.id.enum).toBeUndefined();
  });

  it("is deterministic — same records in same order → same schema", () => {
    const build = () => {
      const a = new SchemaAccumulator();
      a.observeRecord("L", { type: "user", uuid: "u1" }, "type");
      a.observeRecord("L", { type: "assistant", uuid: "u2" }, "type");
      return JSON.stringify(a.finalize());
    };
    expect(build()).toBe(build());
  });

  it("observes nested objects recursively", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("L", { meta: { author: "alice", v: 1 } });
    a.observeRecord("L", { meta: { author: "bob", v: 2 } });
    const out = a.finalize();
    expect(out["L"].fields?.meta.nested?.totalCount).toBe(2);
    expect(out["L"].fields?.meta.nested?.fields?.author.presence).toBe(1);
  });

  it("redacts samples using fieldName-based denylist", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("L", { apiKey: "sk-very-real-looking-key-123abc" });
    const out = a.finalize();
    expect(out["L"].fields?.apiKey.samples).toEqual(["<SECRET>"]);
  });

  it("does not include long strings in enum (paths, prose, content)", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("L", { content: "a".repeat(200) });
    a.observeRecord("L", { content: "b".repeat(200) });
    const out = a.finalize();
    expect(out["L"].fields?.content.enum).toBeUndefined();
  });

  it("treats objects with many distinct keys as maps, hiding key names", () => {
    const a = new SchemaAccumulator();
    const dynamicKeys: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      dynamicKeys[`/Users/alice/file-${i}.ts`] = { after: "x" };
    }
    a.observeRecord("Snapshot", { snapshot: dynamicKeys });
    const out = a.finalize();
    const snapField = out["Snapshot"].fields?.snapshot;
    expect(snapField?.nested).toBeDefined();
    // Per-key fields must NOT leak — map classification kicks in
    expect(snapField?.nested?.fields?.["<map>"]).toBeDefined();
    expect(Object.keys(snapField!.nested!.fields!).every((k) => !k.startsWith("/Users/"))).toBe(true);
  });

  it("redacts values inside the enum field", () => {
    const a = new SchemaAccumulator();
    a.observeRecord("L", { source: "file at /Users/bob/x.ts" });
    a.observeRecord("L", { source: "file at /Users/alice/y.ts" });
    const out = a.finalize();
    expect(out["L"].fields?.source.enum).toBeDefined();
    for (const v of out["L"].fields!.source.enum!) {
      expect(v).not.toMatch(/\/Users\//);
    }
  });
});
