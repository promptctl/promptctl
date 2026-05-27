// [LAW:one-type-per-behavior] Pipeline op for the strip-thinking StepKind.
// Pure (content, step, source) => content. The heuristic that proposes a
// step targeting which messages lives separately in analyzers/strip-thinking.ts.
import type { Step } from "../../../../shared/types";
import type { ClaudeContentBlock, ClaudeLine } from "../../claude/types";
import { targetUuidsForStep } from "../source-index";

export function stripThinking(
  content: string,
  step: Step,
  source: string,
): string {
  const targetUuids = targetUuidsForStep(source, step.targets);
  if (targetUuids.size === 0) return content;

  const outLines: string[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) {
      outLines.push(raw);
      continue;
    }
    let line: ClaudeLine;
    try {
      line = JSON.parse(raw) as ClaudeLine;
    } catch {
      outLines.push(raw);
      continue;
    }
    const uuid = line.uuid;
    if (typeof uuid !== "string" || !targetUuids.has(uuid)) {
      outLines.push(raw);
      continue;
    }
    const message = line.message;
    if (!message || !Array.isArray(message.content)) {
      outLines.push(raw);
      continue;
    }
    const blocks = message.content as ClaudeContentBlock[];
    const filtered = blocks.filter((b) => b.type !== "thinking");
    // [LAW:one-source-of-truth] If filtering removed nothing, the line's
    // semantic content is unchanged — preserve the original raw bytes so
    // we don't emit a spurious diff (JSON.stringify can shuffle key order
    // or whitespace and Claude Code's session file is the source of truth
    // for what's on disk; only re-serialize when we actually changed
    // something).
    if (filtered.length === blocks.length) {
      outLines.push(raw);
      continue;
    }
    message.content = filtered;
    outLines.push(JSON.stringify(line));
  }
  return outLines.join("\n");
}
