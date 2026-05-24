// [LAW:single-enforcer] Structural integrity rules for Claude Code JSONL sessions.
// Pure functions over ClaudeLine[]. No I/O, no adapter state. The editor
// coordinator orchestrates validate → save; callers that skip the editor
// (future API proxy, schema-check CI) run the same validator against whatever
// line array they have.
//
// [LAW:dataflow-not-control-flow] Each rule is a declaration on the RULES array.
// validateClaudeLines loops over the rules; it never branches on rule id.

import type { ClaudeLine, ClaudeContentBlock } from "./types";

export interface InvariantViolation {
  invariantId: string;
  // Human-readable single-line summary — suitable for list items in a dialog.
  summary: string;
  // Optional structured detail for per-row rendering (message previews, ids, etc.).
  offenders: Offender[];
}

// One offender per broken reference / orphaned block / missing parent.
// The renderer formats these; the validator only produces them.
export interface Offender {
  // Index into the input ClaudeLine[] (logical/physical depends on caller;
  // the editor passes the post-filter physical index set).
  lineIndex: number;
  uuid?: string;
  // What's wrong with this specific line/block.
  detail: string;
  // Optional first ~120 chars of a text block for recognizability.
  preview?: string;
}

export interface ValidationResult {
  violations: InvariantViolation[];
}

// --- Helpers over content blocks ------------------------------------------------

function contentBlocks(line: ClaudeLine): ClaudeContentBlock[] {
  const c = line.message?.content;
  return Array.isArray(c) ? c : [];
}

function textPreview(line: ClaudeLine): string | undefined {
  const blocks = contentBlocks(line);
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      return b.text.slice(0, 120).replace(/\n/g, " ");
    }
  }
  if (typeof line.message?.content === "string") {
    return line.message.content.slice(0, 120).replace(/\n/g, " ");
  }
  return undefined;
}

// --- Rules ---------------------------------------------------------------------

type Rule = (lines: ClaudeLine[]) => InvariantViolation | null;

// tool_use_tool_result_pairing
//
// Every tool_use block in an assistant message must have a matching tool_result
// block (tool_result.tool_use_id === tool_use.id) in a subsequent user turn.
// The Anthropic API rejects sessions with orphans in either direction.
const ruleToolUsePairing: Rule = (lines) => {
  const toolUses = new Map<string, { lineIndex: number; blockIndex: number }>();
  const toolResults = new Map<
    string,
    { lineIndex: number; blockIndex: number }
  >();

  for (let i = 0; i < lines.length; i++) {
    const blocks = contentBlocks(lines[i]);
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUses.set(block.id, { lineIndex: i, blockIndex: b });
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        toolResults.set(block.tool_use_id, { lineIndex: i, blockIndex: b });
      }
    }
  }

  const offenders: Offender[] = [];

  // Orphaned tool_result: references a tool_use id that isn't in this session.
  for (const [id, loc] of toolResults) {
    if (!toolUses.has(id)) {
      offenders.push({
        lineIndex: loc.lineIndex,
        uuid: lines[loc.lineIndex].uuid,
        detail: `tool_result block #${loc.blockIndex} references tool_use_id=${id}, which is not in this session`,
        preview: textPreview(lines[loc.lineIndex]),
      });
    }
  }

  // Orphaned tool_use: no subsequent tool_result answered it.
  for (const [id, loc] of toolUses) {
    const result = toolResults.get(id);
    if (!result) {
      offenders.push({
        lineIndex: loc.lineIndex,
        uuid: lines[loc.lineIndex].uuid,
        detail: `tool_use block #${loc.blockIndex} (id=${id}) has no matching tool_result`,
        preview: textPreview(lines[loc.lineIndex]),
      });
    } else if (result.lineIndex < loc.lineIndex) {
      offenders.push({
        lineIndex: loc.lineIndex,
        uuid: lines[loc.lineIndex].uuid,
        detail: `tool_use block (id=${id}) appears after its tool_result; ordering is inverted`,
        preview: textPreview(lines[loc.lineIndex]),
      });
    }
  }

  if (offenders.length === 0) return null;
  offenders.sort((a, b) => a.lineIndex - b.lineIndex);
  return {
    invariantId: "tool_use_tool_result_pairing",
    summary: `${offenders.length} tool_use/tool_result pairing violation${offenders.length === 1 ? "" : "s"} — the Anthropic API will reject this session on resume`,
    offenders,
  };
};

// parent_uuid_chain
//
// Each line's parentUuid should resolve to some earlier line's uuid in the same
// file. The first line of each branch may have no parentUuid (absent). Broken
// chains aren't always fatal to resume, but they degrade Claude Code's view.
const ruleParentChain: Rule = (lines) => {
  const uuids = new Set<string>();
  for (const l of lines) {
    if (typeof l.uuid === "string") uuids.add(l.uuid);
  }

  const offenders: Offender[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parent = (line as { parentUuid?: unknown }).parentUuid;
    if (typeof parent !== "string") continue; // absent/null → branch root, fine
    if (!uuids.has(parent)) {
      offenders.push({
        lineIndex: i,
        uuid: line.uuid,
        detail: `parentUuid=${parent} does not resolve to any uuid in this session`,
        preview: textPreview(line),
      });
    }
  }

  if (offenders.length === 0) return null;
  return {
    invariantId: "parent_uuid_chain",
    summary: `${offenders.length} line${offenders.length === 1 ? " has" : "s have"} a parentUuid with no matching uuid — Claude Code may misconstruct the conversation on resume`,
    offenders,
  };
};

// source_tool_assistant_edge
//
// sourceToolAssistantUUID (observed on some user turns and tool-related lines)
// must resolve to a uuid in the same session. Declared in
// scripts/schema/core/edges.ts — same contract.
const ruleSourceToolAssistantEdge: Rule = (lines) => {
  const uuids = new Set<string>();
  for (const l of lines) {
    if (typeof l.uuid === "string") uuids.add(l.uuid);
  }

  const offenders: Offender[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const src = (line as { sourceToolAssistantUUID?: unknown })
      .sourceToolAssistantUUID;
    if (typeof src !== "string") continue;
    if (!uuids.has(src)) {
      offenders.push({
        lineIndex: i,
        uuid: line.uuid,
        detail: `sourceToolAssistantUUID=${src} does not resolve to any uuid in this session`,
        preview: textPreview(line),
      });
    }
  }

  if (offenders.length === 0) return null;
  return {
    invariantId: "source_tool_assistant_edge",
    summary: `${offenders.length} line${offenders.length === 1 ? " has" : "s have"} a sourceToolAssistantUUID with no matching uuid`,
    offenders,
  };
};

const RULES: Rule[] = [
  ruleToolUsePairing,
  ruleParentChain,
  ruleSourceToolAssistantEdge,
];

// --- Public API ----------------------------------------------------------------

export function validateClaudeLines(lines: ClaudeLine[]): ValidationResult {
  const violations: InvariantViolation[] = [];
  for (const rule of RULES) {
    const v = rule(lines);
    if (v) violations.push(v);
  }
  return { violations };
}

// Convenience: parse the JSONL content string and validate.
// Malformed lines are skipped (same tolerance the adapter applies on load);
// the validator reports integrity, not parseability.
export function validateClaudeContent(content: string): ValidationResult {
  const lines: ClaudeLine[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as ClaudeLine);
    } catch {
      // skip malformed lines
    }
  }
  return validateClaudeLines(lines);
}
