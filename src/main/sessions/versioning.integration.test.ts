// @vitest-environment node
//
// Integration tests for the editor coordinator + version store + Claude adapter.
// Replaces what would otherwise be manual electron app testing — every flow is
// exercised end-to-end against real temp directories.
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadSession,
  saveSession,
  compressToolResults,
  listVersions,
  undo,
  redo,
  restoreVersion,
  diffVersions,
  _resetForTesting,
} from "./editor";
import type { CompressToolsOptions } from "../../shared/types";

// Test presets that emulate the pre-unification "truncate only" / "summarize only"
// behaviour. Tests still want to exercise one strategy at a time; the backend
// dispatches by token count, so we pick thresholds that force the strategy.
const TRUNCATE_ONLY: CompressToolsOptions = {
  summarizeThreshold: Number.MAX_SAFE_INTEGER,
  truncateThreshold: 1000,
  keepLastN: 3,
};
const SUMMARIZE_ONLY: CompressToolsOptions = {
  summarizeThreshold: 1000,
  truncateThreshold: 1000,
  keepLastN: 3,
};
import { _setVersionsRootForTesting } from "./versioning";
import { registerProvider } from "./registry";
import { claudeAdapter } from "./claude/adapter";

let tmpDir: string;
let sessionFile: string;

// --- Fixture helpers ---

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function userMessage(text: string, uuid?: string) {
  return {
    type: "user",
    uuid: uuid ?? crypto.randomUUID(),
    timestamp: "2025-01-01T00:00:00Z",
    message: { role: "user", content: text },
  };
}

function assistantText(text: string, uuid?: string) {
  return {
    type: "assistant",
    uuid: uuid ?? crypto.randomUUID(),
    timestamp: "2025-01-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-4-20250514",
    },
  };
}

function toolResult(content: string, uuid?: string) {
  return {
    type: "user",
    uuid: uuid ?? crypto.randomUUID(),
    timestamp: "2025-01-01T00:01:30Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "x",
          content,
        },
      ],
    },
  };
}

async function writeSession(
  ...lines: Record<string, unknown>[]
): Promise<string> {
  sessionFile = path.join(tmpDir, "test-session.jsonl");
  await writeFile(sessionFile, jsonl(...lines), "utf-8");
  return sessionFile;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "editor-int-"));
  _setVersionsRootForTesting(path.join(tmpDir, "versions"));
  _resetForTesting();
  registerProvider(claudeAdapter);
});

afterEach(async () => {
  _setVersionsRootForTesting(null);
  _resetForTesting();
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// Save: baseline + edit version
// ============================================================

describe("saveSession recording", () => {
  it("records v1 baseline + v2 on first save", async () => {
    const fp = await writeSession(
      userMessage("first", "u1"),
      assistantText("response", "a1"),
      userMessage("second", "u2"),
    );
    await loadSession("claude", fp);

    await saveSession([1]); // remove assistant

    const meta = await listVersions();
    expect(meta.versions).toHaveLength(2);
    expect(meta.versions[0].label).toBe("Initial snapshot");
    expect(meta.versions[1].label).toBe("Removed 1 message");
    expect(meta.head).toBe(2);
  });

  it("records label with correct count for multiple removals", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
      userMessage("c", "u3"),
    );
    await loadSession("claude", fp);
    await saveSession([0, 1]);

    const meta = await listVersions();
    expect(meta.versions[1].label).toBe("Removed 2 messages");
  });

  it("subsequent save creates v3 (no second baseline)", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
      userMessage("c", "u3"),
    );
    await loadSession("claude", fp);

    await saveSession([0]); // v2
    // Reload because saveSession alters file state
    await loadSession("claude", fp);
    await saveSession([0]); // v3

    const meta = await listVersions();
    expect(meta.versions).toHaveLength(3);
    expect(meta.head).toBe(3);
  });
});

// ============================================================
// Undo / Redo
// ============================================================

describe("undo", () => {
  it("restores file content to v1 and decrements head", async () => {
    const fp = await writeSession(
      userMessage("keep", "u1"),
      assistantText("remove", "a1"),
    );
    await loadSession("claude", fp);
    await saveSession([1]); // v2: removed assistant

    const v1Content = await readFile(fp, "utf-8");
    expect(v1Content).not.toContain("remove");

    const messages = await undo();
    expect(messages).not.toBeNull();

    const fileAfter = await readFile(fp, "utf-8");
    expect(fileAfter).toContain("remove"); // back to original

    const meta = await listVersions();
    expect(meta.head).toBe(1);
  });

  it("returns null at v1 (no undo possible)", async () => {
    const fp = await writeSession(userMessage("only"));
    await loadSession("claude", fp);
    await saveSession([]); // creates v1 baseline only (no edit, but records)
    // After save, v1=baseline, v2=saved-no-removals

    const result = await undo();
    expect(result).not.toBeNull(); // can undo from v2 to v1

    const result2 = await undo();
    expect(result2).toBeNull(); // can't undo past v1
  });
});

describe("redo", () => {
  it("restores file content to v2 and increments head", async () => {
    const fp = await writeSession(
      userMessage("keep", "u1"),
      assistantText("remove", "a1"),
    );
    await loadSession("claude", fp);
    await saveSession([1]); // v2

    await undo();
    const fileAfterUndo = await readFile(fp, "utf-8");
    expect(fileAfterUndo).toContain("remove");

    const messages = await redo();
    expect(messages).not.toBeNull();
    const fileAfterRedo = await readFile(fp, "utf-8");
    expect(fileAfterRedo).not.toContain("remove");

    const meta = await listVersions();
    expect(meta.head).toBe(2);
  });

  it("returns null at tip", async () => {
    const fp = await writeSession(userMessage("only"));
    await loadSession("claude", fp);
    await saveSession([]);

    const result = await redo();
    expect(result).toBeNull();
  });
});

describe("undo + new edit drops redo branch", () => {
  it("new edit at non-tip drops the future versions", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
      userMessage("c", "u3"),
    );
    await loadSession("claude", fp);

    await saveSession([0]); // v2
    await loadSession("claude", fp);
    await saveSession([0]); // v3 (removed another)

    // Now at head=3, undo to head=2
    await undo();
    const meta1 = await listVersions();
    expect(meta1.head).toBe(2);

    // New edit should drop v3 and create new v3
    await loadSession("claude", fp);
    await saveSession([]); // v3 fresh

    const meta2 = await listVersions();
    expect(meta2.versions).toHaveLength(3);
    expect(meta2.head).toBe(3);

    // Redo is no longer possible — we're at tip
    expect(await redo()).toBeNull();
  });
});

// ============================================================
// compressToolResults version recording
// ============================================================

describe("compressToolResults version recording", () => {
  it("truncate-only path records version with correct label", async () => {
    const big = "data ".repeat(2000);
    // 4+ tool results so the target isn't in the protected tail (last 3)
    const fp = await writeSession(
      userMessage("run", "u1"),
      toolResult(big, "tr-target"),
      toolResult("filler1", "tr-f1"),
      toolResult("filler2", "tr-f2"),
      toolResult("filler3", "tr-f3"),
    );
    await loadSession("claude", fp);

    await compressToolResults([1], TRUNCATE_ONLY);

    const meta = await listVersions();
    expect(meta.versions).toHaveLength(2);
    expect(meta.versions[0].label).toBe("Initial snapshot");
    expect(meta.versions[1].label).toBe("Truncated 1 tool result");
  });

  it("truncate persists the change to disk", async () => {
    const big = "FIRST_TOKEN " + "filler ".repeat(2000) + " LAST_TOKEN";
    const fp = await writeSession(
      toolResult(big, "tr-target"),
      toolResult("filler1", "tr-f1"),
      toolResult("filler2", "tr-f2"),
      toolResult("filler3", "tr-f3"),
    );
    await loadSession("claude", fp);

    await compressToolResults([0], TRUNCATE_ONLY);

    const fileContent = await readFile(fp, "utf-8");
    expect(fileContent).toContain("tokens omitted"); // truncation marker
    expect(fileContent.length).toBeLessThan(big.length);
  });

  it("summarize-only path records version with correct label", async () => {
    // Mock the LLM client
    const llmClient = await import("../llm/client");
    const spy = vi.spyOn(llmClient, "chatComplete");
    spy.mockResolvedValue("Summary of tool output.");

    const big = "result content\n".repeat(500);
    const fp = await writeSession(
      toolResult(big, "tr-target"),
      toolResult("filler1", "tr-f1"),
      toolResult("filler2", "tr-f2"),
      toolResult("filler3", "tr-f3"),
    );
    await loadSession("claude", fp);

    await compressToolResults([0], SUMMARIZE_ONLY);

    const meta = await listVersions();
    expect(meta.versions[1].label).toBe("Summarized 1 tool result");

    spy.mockRestore();
  });

  it("does not record a version if all targets are protected/too-small", async () => {
    const fp = await writeSession(
      userMessage("hello"),
      toolResult("small1", "tr1"),
      toolResult("small2", "tr2"),
      toolResult("small3", "tr3"),
    );
    await loadSession("claude", fp);

    const result = await compressToolResults([1, 2, 3], TRUNCATE_ONLY);

    // Nothing should have been modified — all 3 are in protected tail
    expect(result.updated).toHaveLength(0);
    expect(result.skippedProtected).toBe(3);

    const meta = await listVersions();
    expect(meta.versions).toHaveLength(0); // no baseline either since nothing changed
  });
});

// ============================================================
// restoreVersion
// ============================================================

describe("restoreVersion", () => {
  it("creates a 'Restored from vN' record and updates head", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
      userMessage("c", "u3"),
    );
    await loadSession("claude", fp);
    await saveSession([0]); // v2
    await loadSession("claude", fp);
    await saveSession([0]); // v3

    const messages = await restoreVersion(1); // restore initial
    expect(messages).not.toBeNull();

    const meta = await listVersions();
    expect(meta.versions).toHaveLength(4);
    expect(meta.versions[3].label).toBe("Restored from v1");
    expect(meta.head).toBe(4);

    // File content should match v1 (original 3 messages)
    const fileContent = await readFile(fp, "utf-8");
    expect(fileContent.split("\n").filter((l) => l.trim())).toHaveLength(3);
  });

  it("returns null for non-existent version", async () => {
    const fp = await writeSession(userMessage("only"));
    await loadSession("claude", fp);
    await saveSession([]);

    const result = await restoreVersion(99);
    expect(result).toBeNull();
  });
});

// ============================================================
// listVersions metadata correctness
// ============================================================

describe("listVersions metadata", () => {
  it("returns ordered versions with correct labels and head after multiple ops", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
      toolResult("data ".repeat(2000), "tr-target"),
      toolResult("filler1", "tr-f1"),
      toolResult("filler2", "tr-f2"),
      toolResult("filler3", "tr-f3"),
    );
    await loadSession("claude", fp);

    // The toolResult fixture emits orphaned tool_result blocks (no paired
    // tool_use) which the validator correctly blocks. This test is about
    // versioning metadata, not validation, so force through.
    await saveSession([0], undefined, true); // v2: Removed 1
    await loadSession("claude", fp);
    // After removing index 0, tr-target shifted from idx 2 to idx 1
    await compressToolResults([1], TRUNCATE_ONLY); // v3: Truncated

    const meta = await listVersions();
    expect(meta.versions.map((v) => v.label)).toEqual([
      "Initial snapshot",
      // Label decorated because the force-save went through with a violation.
      "Removed 1 message (saved with 1 violation)",
      "Truncated 1 tool result",
    ]);
    expect(meta.head).toBe(3);
    expect(meta.versions.every((v) => v.tokensTotal >= 0)).toBe(true);
    expect(meta.versions.every((v) => v.sizeBytes > 0)).toBe(true);
  });
});

// ============================================================
// Crash recovery / state survives restart
// ============================================================

describe("crash recovery", () => {
  it("version state survives 'process restart' (re-reads from disk)", async () => {
    const fp = await writeSession(
      userMessage("a", "u1"),
      userMessage("b", "u2"),
    );
    await loadSession("claude", fp);
    await saveSession([0]); // v2

    // Simulate process restart: reset coordinator, reset version root pointer
    const versionsRoot = path.join(tmpDir, "versions");
    _resetForTesting();
    _setVersionsRootForTesting(null);
    _setVersionsRootForTesting(versionsRoot);

    // Re-load session and check versions
    await loadSession("claude", fp);
    const meta = await listVersions();
    expect(meta.versions).toHaveLength(2);
    expect(meta.head).toBe(2);
  });
});

// ============================================================
// No .backup files
// ============================================================

describe("no .backup files", () => {
  it("save does not create .backup", async () => {
    const fp = await writeSession(userMessage("a"), userMessage("b"));
    await loadSession("claude", fp);
    await saveSession([0]);

    await expect(access(fp + ".backup")).rejects.toThrow();
  });

  it("compressToolResults does not create .backup", async () => {
    const fp = await writeSession(toolResult("data ".repeat(2000)));
    await loadSession("claude", fp);
    await compressToolResults([0], TRUNCATE_ONLY);

    await expect(access(fp + ".backup")).rejects.toThrow();
  });
});

// ============================================================
// diffVersions
// ============================================================

describe("diffVersions", () => {
  it("returns DiffEntry[] showing changes between versions", async () => {
    const fp = await writeSession(
      userMessage("keep", "u1"),
      assistantText("remove", "a1"),
    );
    await loadSession("claude", fp);
    await saveSession([1]); // remove assistant in v2

    const diff = await diffVersions(1, 2);
    expect(diff.length).toBeGreaterThan(0);
    const removed = diff.find((d) => d.kind === "removed");
    expect(removed).toBeDefined();
    if (removed && removed.kind === "removed") {
      expect(removed.messages[0].preview).toContain("remove");
    }
  });

  it("identical versions return only unchanged entries", async () => {
    const fp = await writeSession(userMessage("only"));
    await loadSession("claude", fp);
    await saveSession([]); // v2 = same as v1

    const diff = await diffVersions(1, 2);
    expect(diff.every((d) => d.kind === "unchanged")).toBe(true);
  });

  it("returns empty array for non-existent versions", async () => {
    const fp = await writeSession(userMessage("only"));
    await loadSession("claude", fp);
    await saveSession([]);

    const diff = await diffVersions(99, 100);
    expect(diff).toEqual([]);
  });
});
