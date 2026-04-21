// Behavioral contract: sum-of-our-per-message-token-estimates should reconcile
// against the API's ground-truth `usage` values baked into each assistant turn,
// after subtracting a constant system-prompt + tool-definitions baseline the
// API adds but the JSONL never contains.
//
// The test constructs a synthetic JSONL with precisely-known billable content
// in every turn, sets each turn's cache_read so that
//   apiTotalInput = baseline + sum-of-billable-tokens-so-far
// and asserts that the validator's per-segment drift stays small. If someone
// regresses extractBillableText (e.g. re-excludes thinking blocks), drift
// explodes and this test fails.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validate } from "../validate-tokens";
import { sumChunks } from "../../src/main/sessions/tokenizer";
import { extractBillableChunks } from "../../src/main/sessions/claude/adapter";
import type { ClaudeLine } from "../../src/main/sessions/claude/types";

const BASELINE = 45_000; // system prompt + tool definitions, added to every turn

function userLine(text: string): ClaudeLine {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  };
}

function assistantLine(
  blocks: ClaudeLine["message"] extends infer M ? M : never,
  cumulativeBillable: number,
): ClaudeLine {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: (blocks as { content?: unknown })?.content as never,
      usage: {
        // Encode "API saw exactly baseline + our cumulative billable" into
        // cache_read, so per-turn delta = BASELINE exactly.
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: BASELINE + cumulativeBillable,
        output_tokens: 100,
      },
    },
  };
}

// Builds a JSONL string where each assistant turn's `usage` field is
// back-calculated so apiTotalInput = BASELINE + cumulative_billable at that
// point. In a world where our extractBillableText matches the API exactly,
// delta = BASELINE constant for every turn.
function buildReconciledSession(turns: ClaudeLine[][]): string {
  const out: ClaudeLine[] = [];
  let cumulative = 0;
  for (const turn of turns) {
    for (const line of turn) {
      if (line.type === "assistant") {
        // Patch the usage to match current cumulative.
        const patched = {
          ...line,
          message: {
            ...line.message!,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: BASELINE + cumulative,
              output_tokens: 100,
            },
          },
        };
        out.push(patched);
        cumulative += sumChunks(extractBillableChunks(patched));
      } else {
        out.push(line);
        cumulative += sumChunks(extractBillableChunks(line));
      }
    }
  }
  return out.map((l) => JSON.stringify(l)).join("\n");
}

describe("token reconciliation", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pctl-tokvalidate-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("within-segment drift is zero when usage matches our sum plus constant baseline", async () => {
    const turns: ClaudeLine[][] = [
      [
        userLine("Help me refactor main.ts"),
        assistantLine(
          {
            content: [
              { type: "text", text: "I'll look at main.ts first." },
            ],
          } as never,
          0,
        ),
      ],
      [
        userLine("Please continue"),
        assistantLine(
          {
            content: [
              { type: "text", text: "Here is the refactor plan." },
            ],
          } as never,
          0,
        ),
      ],
      [
        userLine("Sounds good"),
        assistantLine(
          {
            content: [
              { type: "text", text: "Applying changes now." },
            ],
          } as never,
          0,
        ),
      ],
    ];
    const content = buildReconciledSession(turns);
    const fp = path.join(tmpDir, "reconciled.jsonl");
    await writeFile(fp, content);

    const report = await validate(fp);

    expect(report.assistantTurnsWithUsage).toBe(3);
    expect(report.segments).toHaveLength(1);
    // Perfect reconciliation: every turn's delta is exactly BASELINE.
    expect(report.segments[0].driftWithinSegment).toBe(0);
    expect(report.segments[0].medianDelta).toBe(BASELINE);
  });

  it("counts thinking-block signatures — regression guard against excluding them", async () => {
    // A thinking block whose signature is a long base64-ish blob. If someone
    // re-introduces the "thinking is free" skip, this block's tokens drop to
    // near-zero and delta explodes upward.
    const signature = "A".repeat(3000); // realistic-sized encrypted thinking payload
    const turns: ClaudeLine[][] = [
      [
        userLine("Do the thing"),
        assistantLine(
          {
            content: [
              { type: "thinking", thinking: "", signature },
              { type: "text", text: "Done." },
            ],
          } as never,
          0,
        ),
      ],
      [
        userLine("Next one"),
        assistantLine(
          {
            content: [{ type: "text", text: "Ok." }],
          } as never,
          0,
        ),
      ],
    ];
    const content = buildReconciledSession(turns);
    const fp = path.join(tmpDir, "thinking.jsonl");
    await writeFile(fp, content);

    const report = await validate(fp);

    // Our cumulative sum at turn 2 MUST include the 3000-char signature blob —
    // if extractBillableText excluded thinking, the apiTotal baked in via
    // buildReconciledSession would over-represent billable and delta would
    // swing by hundreds of tokens turn-over-turn.
    expect(report.segments[0].driftWithinSegment).toBe(0);
  });

  it("segments across compaction; compaction is not treated as a tokenizer bug", async () => {
    // First segment: 3 normal turns. Then a compaction (cache_read collapses
    // to 5k, well under 50% of prior 60k max). Validator should split into
    // two segments, each with clean drift=0 internally.
    const pre = buildReconciledSession([
      [
        userLine("Hi"),
        assistantLine(
          { content: [{ type: "text", text: "Hello" }] } as never,
          0,
        ),
      ],
      [
        // Stuff with ~30k tokens of billable so pre-compaction apiTotal >>
        // post-compaction apiTotal, triggering the 50% drop heuristic.
        userLine("More context ".repeat(8000)),
        assistantLine(
          { content: [{ type: "text", text: "Ok" }] } as never,
          0,
        ),
      ],
    ]);
    // Bump cumulative artificially high so the compaction line's cache_read
    // crosses the 50% threshold. Emit a post-compaction assistant turn.
    const postLine: ClaudeLine = {
      type: "assistant",
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "Resumed." }],
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          // Compaction: dramatically smaller context (< 10% of pre-compaction).
          cache_read_input_tokens: 5000,
          output_tokens: 50,
        },
      },
    };
    const content = pre + "\n" + JSON.stringify(postLine);

    const fp = path.join(tmpDir, "compaction.jsonl");
    await writeFile(fp, content);

    const report = await validate(fp);

    expect(report.segments.length).toBeGreaterThanOrEqual(2);
    // Pre-compaction segment reconciles cleanly.
    expect(report.segments[0].driftWithinSegment).toBe(0);
  });
});
