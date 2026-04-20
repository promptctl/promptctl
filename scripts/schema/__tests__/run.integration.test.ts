// Integration tests for the extractors. Seeds a tmp corpus, runs extraction
// twice, and asserts byte-level equality of the emitted schema and doc.
//
// [LAW:verifiable-goals] Idempotence is a machine-verifiable property: re-run
// the extractor on the same bytes-in and assert bytes-out are equal.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractClaude } from "../extract-claude";
import { extractGemini } from "../extract-gemini";
import { stableStringify } from "../core/stable-stringify";
import { emitMarkdown } from "../core/emit-markdown";

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n");
}

async function seedClaudeCorpus(root: string): Promise<void> {
  const proj = path.join(root, "-Users-test-project");
  await mkdir(proj, { recursive: true });

  const session1 = jsonl([
    { type: "user", uuid: "u1", timestamp: "2026-04-20T00:00:00Z", message: { role: "user", content: "hello" } },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-04-20T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me read a file" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { path: "/tmp/foo.txt" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sourceToolAssistantUUID: "a1",
      timestamp: "2026-04-20T00:00:02Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file contents here" }],
      },
    },
  ]);
  await writeFile(path.join(proj, "session-1.jsonl"), session1, "utf-8");

  const session2 = jsonl([
    { type: "user", uuid: "u3", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a2", parentUuid: "u3", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ]);
  await writeFile(path.join(proj, "session-2.jsonl"), session2, "utf-8");
}

async function seedGeminiCorpus(root: string): Promise<void> {
  const proj = path.join(root, "test-project", "chats");
  await mkdir(proj, { recursive: true });
  const session = {
    sessionId: "gs-1",
    projectHash: "abc",
    startTime: "2026-04-20T00:00:00Z",
    lastUpdated: "2026-04-20T00:05:00Z",
    kind: "main",
    summary: "a short session",
    messages: [
      { id: "m1", timestamp: "2026-04-20T00:00:00Z", type: "user", content: "hi" },
      { id: "m2", timestamp: "2026-04-20T00:00:01Z", type: "gemini", content: [{ text: "hello back" }] },
    ],
  };
  await writeFile(path.join(proj, "s1.json"), JSON.stringify(session), "utf-8");
}

describe("extractClaude integration", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "schema-claude-"));
    await seedClaudeCorpus(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("discovers all JSONL files and records", async () => {
    const art = await extractClaude({ root: tmp });
    expect(art.corpusMeta.filesScanned).toBe(2);
    expect(art.corpusMeta.recordsScanned).toBe(5);
    expect(art.corpusMeta.parseErrors).toBe(0);
  });

  it("builds a discriminated ClaudeLine record", async () => {
    const art = await extractClaude({ root: tmp });
    const line = art.records["ClaudeLine"];
    expect(line.discriminator).toBe("type");
    expect(line.variants?.user).toBeDefined();
    expect(line.variants?.assistant).toBeDefined();
  });

  it("verifies the parentUuid → uuid edge with the seeded data", async () => {
    const art = await extractClaude({ root: tmp });
    const parentEdge = art.references.find((e) => e.from === "ClaudeLine.parentUuid");
    expect(parentEdge).toBeDefined();
    expect(parentEdge!.resolvedCount).toBeGreaterThan(0);
    expect(parentEdge!.orphanRate).toBe(0);
  });

  it("reports 0 violations for tool_use/tool_result pairing on well-formed corpus", async () => {
    const art = await extractClaude({ root: tmp });
    const inv = art.invariants.find((i) => i.id === "tool_use_tool_result_pairing");
    expect(inv?.observedViolations).toBe(0);
  });

  it("detects orphaned tool_result blocks as invariant violations", async () => {
    const proj = path.join(tmp, "-Users-test-broken");
    await mkdir(proj, { recursive: true });
    const broken = jsonl([
      { type: "user", uuid: "u1", message: { role: "user", content: "x" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "orphan response" }], // no tool_use
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing-tu-id", content: "orphan" }],
        },
      },
    ]);
    await writeFile(path.join(proj, "broken.jsonl"), broken, "utf-8");
    const art = await extractClaude({ root: tmp });
    const inv = art.invariants.find((i) => i.id === "tool_use_tool_result_pairing");
    expect(inv?.observedViolations).toBeGreaterThan(0);
  });

  it("is idempotent — same corpus → same bytes (schema and doc)", async () => {
    const a1 = await extractClaude({ root: tmp });
    const a2 = await extractClaude({ root: tmp });
    // extractedAt is the only non-deterministic field; strip it for comparison
    const norm = (a: typeof a1) => ({ ...a, corpusMeta: { ...a.corpusMeta, extractedAt: "X" } });
    expect(stableStringify(norm(a1))).toBe(stableStringify(norm(a2)));
    expect(emitMarkdown(norm(a1))).toBe(emitMarkdown(norm(a2)));
  });
});

describe("extractGemini integration", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "schema-gemini-"));
    await seedGeminiCorpus(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("discovers Gemini JSON files via <project>/chats/*.json", async () => {
    const art = await extractGemini({ root: tmp });
    expect(art.corpusMeta.filesScanned).toBe(1);
    // 1 session record + 2 message records
    expect(art.corpusMeta.recordsScanned).toBe(3);
  });

  it("produces GeminiSession and discriminated GeminiMessage records", async () => {
    const art = await extractGemini({ root: tmp });
    expect(art.records["GeminiSession"]).toBeDefined();
    expect(art.records["GeminiMessage"].discriminator).toBe("type");
    expect(art.records["GeminiMessage"].variants?.user).toBeDefined();
    expect(art.records["GeminiMessage"].variants?.gemini).toBeDefined();
  });

  it("is idempotent", async () => {
    const a1 = await extractGemini({ root: tmp });
    const a2 = await extractGemini({ root: tmp });
    const norm = (a: typeof a1) => ({ ...a, corpusMeta: { ...a.corpusMeta, extractedAt: "X" } });
    expect(stableStringify(norm(a1))).toBe(stableStringify(norm(a2)));
  });
});
