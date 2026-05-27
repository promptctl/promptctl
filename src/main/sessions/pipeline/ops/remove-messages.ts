// [LAW:one-type-per-behavior] Pipeline op for the remove-messages StepKind.
// Pure (content, step, source) => content. Resolves source-relative targets
// to stable uuids against the initial source, then filters those lines out
// of the running content. Lines not in targets (including non-visible
// metadata lines and lines with no uuid) pass through unchanged.
import type { Step } from "../../../../shared/types";
import type { ClaudeLine } from "../../claude/types";
import { targetUuidsForStep } from "../source-index";

export function removeMessages(
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
    if (typeof line.uuid === "string" && targetUuids.has(line.uuid)) continue;
    outLines.push(raw);
  }
  return outLines.join("\n");
}
