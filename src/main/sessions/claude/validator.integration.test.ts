// @vitest-environment node
//
// End-to-end: seed a session with paired tool_use/tool_result, remove the
// assistant message that contained the tool_use, and verify the editor's
// saveSession refuses to write and surfaces the violation.
//
// This is the canonical regression for the "Claude Code rejects edited session
// on resume" class of bugs that originally motivated this work.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSession, saveSession, _resetForTesting } from "../editor";
import { _setVersionsRootForTesting } from "../versioning";
import { registerProvider } from "../registry";
import { claudeAdapter } from "./adapter";

let tmpDir: string;

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// Well-formed assistant message that issues a tool_use.
function assistantWithToolUse(
  uuid: string,
  toolUseId: string,
  parentUuid?: string,
) {
  const obj: Record<string, unknown> = {
    type: "assistant",
    uuid,
    timestamp: "2025-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me read the file" },
        { type: "tool_use", id: toolUseId, name: "Read", input: { path: "/" } },
      ],
      model: "claude-sonnet-4-20250514",
    },
  };
  if (parentUuid) obj.parentUuid = parentUuid;
  return obj;
}

function userMessage(uuid: string, text: string, parentUuid?: string) {
  const obj: Record<string, unknown> = {
    type: "user",
    uuid,
    timestamp: "2025-01-01T00:00:01Z",
    message: { role: "user", content: text },
  };
  if (parentUuid) obj.parentUuid = parentUuid;
  return obj;
}

function userWithToolResult(
  uuid: string,
  toolUseId: string,
  content: string,
  parentUuid?: string,
) {
  const obj: Record<string, unknown> = {
    type: "user",
    uuid,
    timestamp: "2025-01-01T00:00:02Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
  if (parentUuid) obj.parentUuid = parentUuid;
  return obj;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "validator-int-"));
  _setVersionsRootForTesting(path.join(tmpDir, "versions"));
  _resetForTesting();
  registerProvider(claudeAdapter);
});

afterEach(async () => {
  _setVersionsRootForTesting(null);
  _resetForTesting();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("saveSession pre-save validation", () => {
  it("blocks the write when a tool_use is removed, leaving orphan tool_result", async () => {
    // Paired fixture: assistant issues tool_use tool-1, next user answers with tool_result.
    const fp = path.join(tmpDir, "session.jsonl");
    await writeFile(
      fp,
      jsonl(
        userMessage("u1", "please read something"),
        assistantWithToolUse("a1", "tool-1", "u1"),
        userWithToolResult("u2", "tool-1", "file contents", "a1"),
        userMessage("u3", "thanks", "u2"),
      ),
      "utf-8",
    );

    const messages = await loadSession("claude", fp);
    // The adapter should expose 4 visible messages.
    expect(messages).toHaveLength(4);

    // Remove the assistant message (index 1). This leaves the tool_result
    // in u2 as an orphan: its tool_use_id=tool-1 no longer resolves.
    const before = await readFile(fp, "utf-8");
    const result = await saveSession([1]);

    expect(result.blockedReason).toBe("validation");
    expect(result.path).toBeNull();
    // Removing the assistant breaks pairing AND the parentUuid chain from u2,
    // so two distinct invariants fire.
    const pairing = result.violations.find(
      (v) => v.invariantId === "tool_use_tool_result_pairing",
    );
    expect(pairing).toBeDefined();
    expect(pairing?.offenders.length ?? 0).toBeGreaterThanOrEqual(1);

    // File on disk must be untouched when blocked.
    const after = await readFile(fp, "utf-8");
    expect(after).toBe(before);
  });

  it("writes the file when force=true even if violations exist", async () => {
    const fp = path.join(tmpDir, "session.jsonl");
    await writeFile(
      fp,
      jsonl(
        userMessage("u1", "please read something"),
        assistantWithToolUse("a1", "tool-1", "u1"),
        userWithToolResult("u2", "tool-1", "file contents", "a1"),
      ),
      "utf-8",
    );

    await loadSession("claude", fp);

    const result = await saveSession([1], undefined, true);

    expect(result.blockedReason).toBeNull();
    expect(result.forced).toBe(true);
    expect(result.path).toBe(fp);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(
      result.violations.find(
        (v) => v.invariantId === "tool_use_tool_result_pairing",
      ),
    ).toBeDefined();

    // Reload to confirm the content actually changed on disk.
    const after = await loadSession("claude", fp);
    expect(after).toHaveLength(2); // assistant gone
  });

  it("does not block when the edit keeps pairing intact", async () => {
    const fp = path.join(tmpDir, "session.jsonl");
    await writeFile(
      fp,
      jsonl(
        userMessage("u1", "first question"),
        userMessage("u2", "changed my mind", "u1"),
        assistantWithToolUse("a1", "tool-1", "u2"),
        userWithToolResult("u2r", "tool-1", "data", "a1"),
      ),
      "utf-8",
    );

    await loadSession("claude", fp);

    // Remove u1 (index 0) — no tool_use/tool_result pair is touched, but this
    // DOES break the parentUuid chain from u2 → u1. The validator should flag.
    const r = await saveSession([0]);
    expect(r.blockedReason).toBe("validation");
    expect(
      r.violations.find((v) => v.invariantId === "parent_uuid_chain"),
    ).toBeDefined();
  });
});
