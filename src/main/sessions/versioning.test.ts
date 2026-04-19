// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  recordVersion,
  ensureBaseline,
  listVersions,
  getVersionContent,
  undo,
  redo,
  restoreVersion,
  _setVersionsRootForTesting,
} from "./versioning";

let tmpDir: string;
let sessionPath: string;

function assertPresent<T>(value: T | null | undefined): asserts value is T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "versioning-test-"));
  // Override versions root to live inside tmpDir
  _setVersionsRootForTesting(path.join(tmpDir, "versions"));
  // Default session path used by most tests
  sessionPath = path.join(tmpDir, "session.jsonl");
  await writeFile(sessionPath, "initial content\n", "utf-8");
});

afterEach(async () => {
  _setVersionsRootForTesting(null);
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// recordVersion
// ============================================================

describe("recordVersion", () => {
  it("appends a new version and advances head", async () => {
    const info = await recordVersion(sessionPath, "claude", "v1 content", "First", 100);
    expect(info.idx).toBe(1);
    expect(info.label).toBe("First");

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(1);
    expect(meta.head).toBe(1);
  });

  it("each subsequent record increments idx and head", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 100);
    await recordVersion(sessionPath, "claude", "v2", "B", 200);
    await recordVersion(sessionPath, "claude", "v3", "C", 300);

    const meta = await listVersions(sessionPath);
    expect(meta.versions.map((v) => v.idx)).toEqual([1, 2, 3]);
    expect(meta.head).toBe(3);
  });

  it("recording at head < tip drops the tail (redo branch lost)", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 100);
    await recordVersion(sessionPath, "claude", "v2", "B", 200);
    await recordVersion(sessionPath, "claude", "v3", "C", 300);

    // Undo twice → head=1
    await undo(sessionPath);
    await undo(sessionPath);

    const meta1 = await listVersions(sessionPath);
    expect(meta1.head).toBe(1);
    expect(meta1.versions).toHaveLength(3); // not yet dropped

    // New edit at head=1 drops v2, v3 and creates v2 fresh
    await recordVersion(sessionPath, "claude", "vNew", "D", 400);

    const meta2 = await listVersions(sessionPath);
    expect(meta2.versions).toHaveLength(2);
    expect(meta2.versions.map((v) => v.label)).toEqual(["A", "D"]);
    expect(meta2.head).toBe(2);
  });

  it("stores correct sizeBytes and tokensTotal", async () => {
    const content = "hello world";
    const info = await recordVersion(sessionPath, "claude", content, "Test", 500);
    expect(info.sizeBytes).toBe(Buffer.byteLength(content, "utf-8"));
    expect(info.tokensTotal).toBe(500);
  });

  it("stores ISO timestamp", async () => {
    const info = await recordVersion(sessionPath, "claude", "x", "Test", 0);
    expect(info.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ============================================================
// ensureBaseline
// ============================================================

describe("ensureBaseline", () => {
  it("creates v1 from current file content if no versions exist", async () => {
    await writeFile(sessionPath, "baseline content\n", "utf-8");
    const created = await ensureBaseline(sessionPath, "claude", 50);
    expect(created).toBe(true);

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0].label).toBe("Initial snapshot");
    expect(meta.head).toBe(1);

    const v1 = await getVersionContent(sessionPath, 1);
    expect(v1).toBe("baseline content\n");
  });

  it("does nothing if a baseline already exists", async () => {
    await recordVersion(sessionPath, "claude", "v1", "First", 0);
    const created = await ensureBaseline(sessionPath, "claude", 0);
    expect(created).toBe(false);

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0].label).toBe("First");
  });
});

// ============================================================
// listVersions
// ============================================================

describe("listVersions", () => {
  it("returns empty meta when no versions exist", async () => {
    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(0);
    expect(meta.head).toBe(0);
  });

  it("returns versions in idx order with current head", async () => {
    await recordVersion(sessionPath, "claude", "a", "A", 100);
    await recordVersion(sessionPath, "claude", "b", "B", 200);
    await undo(sessionPath);

    const meta = await listVersions(sessionPath);
    expect(meta.versions.map((v) => v.idx)).toEqual([1, 2]);
    expect(meta.head).toBe(1);
  });
});

// ============================================================
// getVersionContent
// ============================================================

describe("getVersionContent", () => {
  it("returns exact bytes recorded", async () => {
    const content = "line 1\nline 2\nline 3\n";
    await recordVersion(sessionPath, "claude", content, "Test", 0);
    const fetched = await getVersionContent(sessionPath, 1);
    expect(fetched).toBe(content);
  });

  it("returns null for non-existent version", async () => {
    await recordVersion(sessionPath, "claude", "x", "Test", 0);
    const fetched = await getVersionContent(sessionPath, 99);
    expect(fetched).toBeNull();
  });

  it("returns null when no versions exist at all", async () => {
    const fetched = await getVersionContent(sessionPath, 1);
    expect(fetched).toBeNull();
  });
});

// ============================================================
// undo
// ============================================================

describe("undo", () => {
  it("returns previous version content and decrements head", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);

    const result = await undo(sessionPath);
    assertPresent(result);
    expect(result.content).toBe("v1");
    expect(result.newHead).toBe(1);

    const meta = await listVersions(sessionPath);
    expect(meta.head).toBe(1);
  });

  it("returns null at head=1 (no undo possible)", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    const result = await undo(sessionPath);
    expect(result).toBeNull();
  });

  it("returns null when no versions exist", async () => {
    const result = await undo(sessionPath);
    expect(result).toBeNull();
  });

  it("multiple undos walk the chain", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);
    await recordVersion(sessionPath, "claude", "v3", "C", 0);

    const u1 = await undo(sessionPath);
    assertPresent(u1);
    expect(u1.newHead).toBe(2);
    const u2 = await undo(sessionPath);
    assertPresent(u2);
    expect(u2.newHead).toBe(1);
    expect(await undo(sessionPath)).toBeNull();
  });
});

// ============================================================
// redo
// ============================================================

describe("redo", () => {
  it("returns next version content and increments head", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);
    await undo(sessionPath); // head=1

    const result = await redo(sessionPath);
    assertPresent(result);
    expect(result.content).toBe("v2");
    expect(result.newHead).toBe(2);

    const meta = await listVersions(sessionPath);
    expect(meta.head).toBe(2);
  });

  it("returns null at tip (no redo possible)", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);
    const result = await redo(sessionPath);
    expect(result).toBeNull();
  });

  it("returns null when no versions exist", async () => {
    const result = await redo(sessionPath);
    expect(result).toBeNull();
  });
});

// ============================================================
// restoreVersion
// ============================================================

describe("restoreVersion", () => {
  it("creates a new 'Restored from vN' entry", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 100);
    await recordVersion(sessionPath, "claude", "v2", "B", 200);
    await recordVersion(sessionPath, "claude", "v3", "C", 300);

    const restored = await restoreVersion(sessionPath, "claude", 1);
    assertPresent(restored);
    expect(restored.idx).toBe(4);
    expect(restored.label).toBe("Restored from v1");

    const meta = await listVersions(sessionPath);
    expect(meta.head).toBe(4);
    expect(meta.versions).toHaveLength(4);
  });

  it("restored content matches the source version content", async () => {
    await recordVersion(sessionPath, "claude", "OLD content", "A", 0);
    await recordVersion(sessionPath, "claude", "NEW content", "B", 0);

    await restoreVersion(sessionPath, "claude", 1);
    const restored = await getVersionContent(sessionPath, 3);
    expect(restored).toBe("OLD content");
  });

  it("returns null for non-existent version", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    const result = await restoreVersion(sessionPath, "claude", 99);
    expect(result).toBeNull();
  });
});

// ============================================================
// Hash stability and collision
// ============================================================

describe("path hashing", () => {
  it("different paths get different version directories", async () => {
    const otherPath = path.join(tmpDir, "other.jsonl");
    await writeFile(otherPath, "x", "utf-8");

    await recordVersion(sessionPath, "claude", "for session", "A", 0);
    await recordVersion(otherPath, "claude", "for other", "B", 0);

    const sessionMeta = await listVersions(sessionPath);
    const otherMeta = await listVersions(otherPath);

    expect(sessionMeta.versions[0].label).toBe("A");
    expect(otherMeta.versions[0].label).toBe("B");
  });

  it("same path produces stable hash across calls", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    const meta1 = await listVersions(sessionPath);

    await recordVersion(sessionPath, "claude", "v2", "B", 0);
    const meta2 = await listVersions(sessionPath);

    expect(meta2.versions).toHaveLength(2);
    expect(meta2.versions[0].idx).toBe(meta1.versions[0].idx);
  });
});

// ============================================================
// Crash recovery / corrupted meta
// ============================================================

describe("recovery", () => {
  it("corrupted meta.json: returns empty history (does not throw)", async () => {
    // Create the version dir manually with a corrupted meta
    const { _versionsRoot } = await import("./versioning");
    const fs = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256")
      .update(sessionPath)
      .digest("hex")
      .slice(0, 16);
    const versionDir = path.join(_versionsRoot(), hash);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "meta.json"),
      "not valid json{{",
      "utf-8",
    );

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(0);
    expect(meta.head).toBe(0);
  });

  it("missing meta.json: returns empty history", async () => {
    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(0);
  });

  it("state survives 'process restart' (re-reads from disk)", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 100);
    await recordVersion(sessionPath, "claude", "v2", "B", 200);

    // Simulate process restart: reset and re-init versions root pointing to same dir
    const root = path.join(tmpDir, "versions");
    _setVersionsRootForTesting(null);
    _setVersionsRootForTesting(root);

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(2);
    expect(meta.head).toBe(2);

    const v1 = await getVersionContent(sessionPath, 1);
    expect(v1).toBe("v1");
  });
});

// ============================================================
// Integration: undo + redo + new edit cycle
// ============================================================

describe("undo/redo cycle", () => {
  it("undo then redo returns to same state", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);

    await undo(sessionPath);
    expect((await listVersions(sessionPath)).head).toBe(1);

    await redo(sessionPath);
    expect((await listVersions(sessionPath)).head).toBe(2);
  });

  it("undo then new edit drops redo branch", async () => {
    await recordVersion(sessionPath, "claude", "v1", "A", 0);
    await recordVersion(sessionPath, "claude", "v2", "B", 0);
    await recordVersion(sessionPath, "claude", "v3", "C", 0);

    await undo(sessionPath); // head=2
    await recordVersion(sessionPath, "claude", "vNew", "D", 0); // drops v3

    const meta = await listVersions(sessionPath);
    expect(meta.versions).toHaveLength(3);
    expect(meta.versions.map((v) => v.label)).toEqual(["A", "B", "D"]);
    expect(meta.head).toBe(3);

    // No redo possible at tip
    expect(await redo(sessionPath)).toBeNull();
  });
});
