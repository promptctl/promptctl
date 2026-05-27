// [LAW:one-type-per-behavior] This file owns the HEURISTIC (which messages
// have suspicious thinking blocks). The corresponding pipeline op
// (pipeline/ops/strip-thinking.ts) owns the MUTATION (how to remove them).
// They are two distinct types by design — the heuristic never lives inside
// the step.
//
// Why this matters: thinking blocks ship with a per-block signature that the
// Anthropic API checks on re-send. A session re-played without valid
// signatures crashes at runtime, and there is no recovery without stripping
// the offending blocks. Sessions from non-Claude providers (Codex/OpenAI
// converted JSONL, hand-authored synthetic data) emit assistant turns with
// model fields that don't start with "claude-", and their thinking blocks
// are unsigned by construction. We catch both as one flag.
import { readFile } from "node:fs/promises";
import type { AnalyzerResult } from "../../../shared/types";
import { isVisibleMessage } from "../claude/adapter";
import type { ClaudeContentBlock, ClaudeLine } from "../claude/types";
import type { Analyzer } from "./types";

export const STRIP_THINKING_ID = "strip-thinking";

function thinkingBlocks(line: ClaudeLine): ClaudeContentBlock[] {
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === "thinking");
}

// Per-block validity check. A block is "valid" iff:
//  - signature is a non-empty string, AND
//  - if `thinking` is present, it's a string (not e.g. an array or object).
// Anything else means the block won't replay against Anthropic and must be
// stripped from the message before re-sending.
function isInvalidThinkingBlock(block: ClaudeContentBlock): boolean {
  const obj = block as Record<string, unknown>;
  const signature = obj.signature;
  if (typeof signature !== "string" || signature.length === 0) return true;
  if ("thinking" in obj && typeof obj.thinking !== "string") return true;
  return false;
}

// Heuristic for non-Anthropic origin. The assistant.message.model field
// names the model that produced the turn; Claude Code (and Anthropic API
// replays) write models like "claude-sonnet-4-5-20250929". Anything else
// (openai/gpt-5, gemini-pro, etc.) is non-Anthropic — its thinking blocks
// were not signed by Anthropic and cannot be replayed even if structurally
// shaped right. Missing model field doesn't trigger this (we can't claim
// non-Anthropic from absence).
function isNonClaudeOrigin(line: ClaudeLine): boolean {
  const model = line.message?.model;
  if (typeof model !== "string") return false;
  return !model.startsWith("claude-");
}

export const stripThinkingAnalyzer: Analyzer = {
  id: STRIP_THINKING_ID,
  name: "Strip Thinking",
  description:
    "Find assistant messages whose thinking blocks have missing/invalid signatures or come from a non-Anthropic origin. Anthropic rejects re-sent sessions whose thinking signatures don't validate.",
  providerId: "claude",

  async run(filePath): Promise<AnalyzerResult> {
    const content = await readFile(filePath, "utf-8");
    const flagged: number[] = [];

    // logicalIndex mirrors MessageSummary.index — increments only on visible
    // messages. Targets in the recommendation are these indices, so they
    // line up 1:1 with the renderer's MessageRow data.
    let logicalIndex = -1;
    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      let line: ClaudeLine;
      try {
        line = JSON.parse(raw) as ClaudeLine;
      } catch {
        continue;
      }
      if (!isVisibleMessage(line)) continue;
      logicalIndex++;
      if (line.type !== "assistant") continue;
      const blocks = thinkingBlocks(line);
      if (blocks.length === 0) continue;

      const anyInvalid = blocks.some(isInvalidThinkingBlock);
      const nonClaude = isNonClaudeOrigin(line);
      if (anyInvalid || nonClaude) {
        flagged.push(logicalIndex);
      }
    }

    if (flagged.length === 0) {
      return {
        analyzerId: STRIP_THINKING_ID,
        recommendations: [],
        summary: "No problems detected.",
      };
    }

    // [LAW:dataflow-not-control-flow] One recommendation targeting all flagged
    // indices — not one per message. The user edits the target list before
    // accepting if they want finer control; the analyzer is the proposer.
    return {
      analyzerId: STRIP_THINKING_ID,
      recommendations: [
        {
          step: {
            source: STRIP_THINKING_ID,
            kind: "strip-thinking",
            targets: flagged,
            rationale: `${flagged.length} message${flagged.length === 1 ? "" : "s"} have thinking blocks with missing/invalid signatures or non-Anthropic origin`,
          },
        },
      ],
      summary: `Found ${flagged.length} message${flagged.length === 1 ? "" : "s"}.`,
    };
  },
};
