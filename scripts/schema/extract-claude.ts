// Extractor for Claude Code JSONL session files. Walks the corpus, feeds records
// into the accumulator, collects reference values and invariant stats, and
// returns a SchemaArtifact ready to be written.
//
// [LAW:single-enforcer] The adapter parses sessions for the app. This extractor
// reads the same type declarations (src/main/sessions/claude/types.ts) but does
// its own walking so it can observe *all* records including lines the adapter
// treats as non-visible metadata.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ClaudeLine, ClaudeContentBlock } from "../../src/main/sessions/claude/types";
import { SchemaAccumulator } from "./core/accumulator";
import {
  CLAUDE_EDGES,
  indexValue,
  suggestEdges,
  verifyDeclaredEdges,
  type ValueIndex,
} from "./core/edges";
import { CLAUDE_INVARIANTS } from "./core/invariants";
import type {
  Invariant,
  SchemaArtifact,
} from "./core/types";

export const CLAUDE_EXTRACTOR_VERSION = "1";

export interface ExtractOptions {
  root: string;
  maxFiles?: number;
  /** Progress callback — called with counts periodically. */
  onProgress?: (stats: { filesScanned: number; filesTotal: number; recordsScanned: number }) => void;
}

export async function extractClaude(opts: ExtractOptions): Promise<SchemaArtifact> {
  const accum = new SchemaAccumulator();
  const valueIndex: ValueIndex = new Map();
  const fromValues = new Map<string, string[]>();

  let filesScanned = 0;
  let recordsScanned = 0;
  let parseErrors = 0;
  const invariantStats = new Map<string, { violations: number; samples: string[] }>();
  for (const inv of CLAUDE_INVARIANTS) {
    invariantStats.set(inv.id, { violations: 0, samples: [] });
  }

  const files = await collectJsonlFiles(opts.root);
  files.sort();
  const filesToScan = opts.maxFiles ? files.slice(0, opts.maxFiles) : files;

  for (const filePath of filesToScan) {
    const sessionLines: ClaudeLine[] = [];
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      parseErrors++;
      continue;
    }
    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      let parsed: ClaudeLine;
      try {
        parsed = JSON.parse(raw) as ClaudeLine;
      } catch {
        parseErrors++;
        continue;
      }
      sessionLines.push(parsed);
      recordsScanned++;
      accum.observeRecord("ClaudeLine", parsed as unknown as Record<string, unknown>, "type");
      collectValues(parsed, valueIndex, fromValues);
    }
    verifyPairingInvariant(sessionLines, filePath, invariantStats);
    filesScanned++;
    if (opts.onProgress && filesScanned % 100 === 0) {
      opts.onProgress({ filesScanned, filesTotal: filesToScan.length, recordsScanned });
    }
  }
  opts.onProgress?.({ filesScanned, filesTotal: filesToScan.length, recordsScanned });

  const records = accum.finalize();
  const references = verifyDeclaredEdges(CLAUDE_EDGES, fromValues, valueIndex);
  const suggestedReferences = suggestEdges(valueIndex, CLAUDE_EDGES);

  const invariants: Invariant[] = CLAUDE_INVARIANTS.map((inv) => {
    const stats = invariantStats.get(inv.id);
    return {
      ...inv,
      observedViolations: stats?.violations ?? 0,
      observedSamples: stats?.samples.slice(0, 3),
    };
  });

  return {
    corpusMeta: {
      provider: "claude",
      corpusRoot: opts.root,
      filesScanned,
      recordsScanned,
      parseErrors,
      extractedAt: new Date().toISOString(),
      extractorVersion: CLAUDE_EXTRACTOR_VERSION,
    },
    records,
    references,
    suggestedReferences,
    invariants,
  };
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  for (const d of dirs.sort()) {
    const full = path.join(root, d);
    const s = await stat(full).catch(() => null);
    if (!s?.isDirectory()) continue;
    const files = await readdir(full).catch(() => []);
    for (const f of files.sort()) {
      if (typeof f !== "string" || !f.endsWith(".jsonl")) continue;
      out.push(path.join(full, f));
    }
  }
  return out;
}

// Walk a record and feed (fieldPath → string value) pairs into both indexes.
// fromValues keeps duplicates (lets us count a field's total observations);
// valueIndex deduplicates (for set-intersection during edge verification).
function collectValues(
  line: ClaudeLine,
  toIndex: ValueIndex,
  fromValues: Map<string, string[]>,
): void {
  const root = "ClaudeLine";
  visit(line, root, toIndex, fromValues);
  const content = line.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const variantKey = typeof block.type === "string" ? block.type : "<absent>";
      const blockPath = `${root}.message.content[${variantKey}]`;
      visit(block as unknown as Record<string, unknown>, blockPath, toIndex, fromValues, "type");
    }
  }
}

function visit(
  obj: unknown,
  pathSoFar: string,
  toIndex: ValueIndex,
  fromValues: Map<string, string[]>,
  skipField?: string,
): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === skipField) continue;
    const fieldPath = `${pathSoFar}.${k}`;
    if (typeof v === "string" && v.length > 0) {
      indexValue(toIndex, fieldPath, v);
      const arr = fromValues.get(fieldPath) ?? [];
      arr.push(v);
      fromValues.set(fieldPath, arr);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      visit(v, fieldPath, toIndex, fromValues);
    }
  }
}

// Contract: every tool_use in an assistant message must have a matching
// tool_result (by tool_use_id) in a later user message in the same session.
function verifyPairingInvariant(
  lines: ClaudeLine[],
  filePath: string,
  stats: Map<string, { violations: number; samples: string[] }>,
): void {
  const pairingStats = stats.get("tool_use_tool_result_pairing");
  if (!pairingStats) return;

  const openToolUses = new Map<string, ClaudeLine>();
  for (const line of lines) {
    if (line.isSidechain === true) continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    if (line.type === "assistant") {
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          openToolUses.set(block.id, line);
        }
      }
    } else if (line.type === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          if (openToolUses.has(block.tool_use_id)) {
            openToolUses.delete(block.tool_use_id);
          } else {
            pairingStats.violations++;
            if (pairingStats.samples.length < 3) {
              pairingStats.samples.push(
                `orphan tool_result tool_use_id=${block.tool_use_id} at ${path.basename(filePath)}`,
              );
            }
          }
        }
      }
    }
  }
  // Any tool_use still open at end of session is also a violation
  for (const [id] of openToolUses) {
    pairingStats.violations++;
    if (pairingStats.samples.length < 3) {
      pairingStats.samples.push(
        `unmatched tool_use id=${id} at ${path.basename(filePath)}`,
      );
    }
  }
}

// Silence unused-import warning at module level — the type is imported to keep
// the extractor's structural contract aligned with the adapter's.
export type _ClaudeContentBlockShape = ClaudeContentBlock;
