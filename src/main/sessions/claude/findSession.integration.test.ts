// @vitest-environment node
//
// Integration test for claudeAdapter.findSession — exercises real filesystem
// layout under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl by redirecting
// HOME at a temp dir before the adapter module loads.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { claudeAdapter as ClaudeAdapterT } from "./adapter";

let tmpHome: string;
let adapter: typeof ClaudeAdapterT;

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), "promptctl-findsession-"));
  process.env.HOME = tmpHome;
  // Reset module cache so the adapter's CLAUDE_PROJECTS constant re-reads HOME.
  vi.resetModules();
  const mod = await import("./adapter");
  adapter = mod.claudeAdapter;
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

function jsonl(...lines: Record<string, unknown>[]) {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

async function seedSession(
  projectDirName: string,
  sessionId: string,
  cwd: string,
) {
  const projectDir = path.join(tmpHome, ".claude", "projects", projectDirName);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    jsonl(
      {
        type: "user",
        sessionId,
        cwd,
        timestamp: "2026-04-18T10:00:00Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        sessionId,
        timestamp: "2026-04-18T10:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi back" }],
        },
      },
    ),
  );
  return file;
}

describe("claudeAdapter.findSession", () => {
  it("locates a session by id and returns project + session", async () => {
    const sid = "abc-123";
    const filePath = await seedSession(
      "-Users-bmf-code-promptctl",
      sid,
      "/Users/bmf/code/promptctl",
    );

    const result = await adapter.findSession(sid);
    if (!result) throw new Error("expected a result");
    expect(result.project.provider).toBe("claude");
    expect(result.project.projectRoot).toBe("/Users/bmf/code/promptctl");
    expect(result.project.name).toBe("promptctl");
    expect(result.session.sessionId).toBe(sid);
    expect(result.session.filePath).toBe(filePath);
    expect(result.session.messageCount).toBe(2);
  });

  it("returns null when no session matches", async () => {
    await seedSession(
      "-Users-bmf-code-promptctl",
      "real-id",
      "/Users/bmf/code/promptctl",
    );
    const result = await adapter.findSession("missing-id");
    expect(result).toBeNull();
  });

  it("returns null when ~/.claude/projects does not exist", async () => {
    const result = await adapter.findSession("anything");
    expect(result).toBeNull();
  });
});
