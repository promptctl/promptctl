import { describe, it, expect } from "vitest";
import { validateClaudeLines, validateClaudeContent } from "./validator";
import type { ClaudeLine } from "./types";

function line(partial: Partial<ClaudeLine> & { type: string }): ClaudeLine {
  return partial as ClaudeLine;
}

function assistantWithToolUse(uuid: string, toolUseId: string): ClaudeLine {
  return line({
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        { type: "tool_use", id: toolUseId, name: "Read", input: {} },
      ],
    },
  });
}

function userWithToolResult(
  uuid: string,
  toolUseId: string,
  parent?: string,
): ClaudeLine {
  const obj: Record<string, unknown> = {
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  };
  if (parent) obj.parentUuid = parent;
  return obj as ClaudeLine;
}

describe("validateClaudeLines — happy path", () => {
  it("reports no violations for a well-paired session", () => {
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
      }),
      {
        ...assistantWithToolUse("a1", "tool-1"),
        parentUuid: "u1",
      } as ClaudeLine,
      userWithToolResult("u2", "tool-1", "a1"),
    ];
    expect(validateClaudeLines(lines).violations).toEqual([]);
  });

  it("tolerates absent parentUuid at branch roots", () => {
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
      }),
    ];
    expect(validateClaudeLines(lines).violations).toEqual([]);
  });
});

describe("validateClaudeLines — tool_use/tool_result pairing", () => {
  it("flags orphaned tool_result when the tool_use was removed", () => {
    // Scenario: user trimmed the assistant line; tool_result now has no match.
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
      }),
      userWithToolResult("u2", "tool-1", "u1"),
    ];
    const result = validateClaudeLines(lines);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].invariantId).toBe(
      "tool_use_tool_result_pairing",
    );
    expect(result.violations[0].offenders).toHaveLength(1);
    expect(result.violations[0].offenders[0].detail).toMatch(/tool-1/);
    expect(result.violations[0].offenders[0].lineIndex).toBe(1);
  });

  it("flags orphaned tool_use with no answering tool_result", () => {
    const lines = [
      assistantWithToolUse("a1", "tool-1"),
      // no tool_result for tool-1
    ];
    const result = validateClaudeLines(lines);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].offenders[0].detail).toMatch(
      /no matching tool_result/,
    );
  });

  it("flags inverted ordering where tool_result precedes tool_use", () => {
    const lines = [
      userWithToolResult("u1", "tool-1"),
      assistantWithToolUse("a1", "tool-1"),
    ];
    const result = validateClaudeLines(lines);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].offenders[0].detail).toMatch(
      /ordering is inverted/,
    );
  });

  it("aggregates multiple orphans into a single violation entry", () => {
    const lines = [
      userWithToolResult("u1", "tool-1"),
      userWithToolResult("u2", "tool-2"),
      userWithToolResult("u3", "tool-3"),
    ];
    const result = validateClaudeLines(lines);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].offenders).toHaveLength(3);
    expect(result.violations[0].summary).toMatch(/3 tool_use\/tool_result/);
  });
});

describe("validateClaudeLines — parent_uuid_chain", () => {
  it("flags a parentUuid that doesn't resolve to any line", () => {
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
        parentUuid: "nonexistent-uuid",
      } as ClaudeLine),
    ];
    const result = validateClaudeLines(lines);
    const v = result.violations.find(
      (x) => x.invariantId === "parent_uuid_chain",
    );
    if (!v) throw new Error("expected parent_uuid_chain violation");
    expect(v.offenders[0].detail).toMatch(/nonexistent-uuid/);
  });

  it("tolerates a parentUuid that points to a later line", () => {
    // Chain integrity check is resolvability, not ordering. Ordering is a
    // separate concern (and today not a strict requirement of the corpus).
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
        parentUuid: "u2",
      } as ClaudeLine),
      line({
        type: "user",
        uuid: "u2",
        message: { role: "user", content: "hi" },
      }),
    ];
    const parentViolations = validateClaudeLines(lines).violations.filter(
      (v) => v.invariantId === "parent_uuid_chain",
    );
    expect(parentViolations).toEqual([]);
  });
});

describe("validateClaudeLines — source_tool_assistant_edge", () => {
  it("flags an unresolved sourceToolAssistantUUID", () => {
    const lines = [
      line({
        type: "user",
        uuid: "u1",
        sourceToolAssistantUUID: "ghost-uuid",
        message: { role: "user", content: "hi" },
      } as ClaudeLine),
    ];
    const v = validateClaudeLines(lines).violations.find(
      (x) => x.invariantId === "source_tool_assistant_edge",
    );
    if (!v) throw new Error("expected source_tool_assistant_edge violation");
    expect(v.offenders[0].detail).toMatch(/ghost-uuid/);
  });
});

describe("validateClaudeContent", () => {
  it("parses JSONL and validates", () => {
    const content = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-gone", content: "x" },
          ],
        },
      }),
      "", // blank lines tolerated
      JSON.stringify({
        type: "user",
        uuid: "u2",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n");
    const result = validateClaudeContent(content);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].invariantId).toBe(
      "tool_use_tool_result_pairing",
    );
  });

  it("skips malformed JSON lines without aborting", () => {
    const content = [
      "{malformed",
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n");
    expect(validateClaudeContent(content).violations).toEqual([]);
  });
});
