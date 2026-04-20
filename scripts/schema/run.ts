// CLI entrypoint for the schema extractor. Runs one or both provider extractors,
// writes the schema JSON and generated markdown, and supports --check mode for CI.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractClaude } from "./extract-claude";
import { extractGemini } from "./extract-gemini";
import { emitMarkdown } from "./core/emit-markdown";
import { stableStringify } from "./core/stable-stringify";
import type { SchemaArtifact } from "./core/types";

const HOME = process.env.HOME ?? "";
const DEFAULT_CLAUDE_ROOT = path.join(HOME, ".claude", "projects");
const DEFAULT_GEMINI_ROOT = path.join(HOME, ".gemini", "tmp");
const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "docs", "session-formats");

interface CliOpts {
  provider: "claude" | "gemini" | "all";
  root?: string;
  outSchema?: string;
  outDoc?: string;
  check: boolean;
  maxFiles?: number;
  maxOrphanRate: number;
}

function parseArgs(argv: string[]): CliOpts {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const provider = positional[0];
  if (!provider || !["claude", "gemini", "all"].includes(provider)) {
    throw new Error(
      `Usage: tsx scripts/schema/run.ts <claude|gemini|all> [--root <path>] [--out-schema <path>] [--out-doc <path>] [--check] [--max-files N] [--max-orphan-rate 0.01]`,
    );
  }
  const opts: CliOpts = {
    provider: provider as CliOpts["provider"],
    check: false,
    maxOrphanRate: 0.01,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      opts.check = true;
    } else if (arg === "--root") {
      opts.root = argv[++i];
    } else if (arg === "--out-schema") {
      opts.outSchema = argv[++i];
    } else if (arg === "--out-doc") {
      opts.outDoc = argv[++i];
    } else if (arg === "--max-files") {
      opts.maxFiles = Number(argv[++i]);
    } else if (arg === "--max-orphan-rate") {
      opts.maxOrphanRate = Number(argv[++i]);
    }
  }
  return opts;
}

async function runOne(
  provider: "claude" | "gemini",
  opts: CliOpts,
): Promise<number> {
  const defaultRoot = provider === "claude" ? DEFAULT_CLAUDE_ROOT : DEFAULT_GEMINI_ROOT;
  const root = opts.root ?? defaultRoot;
  const outSchema = opts.outSchema ?? path.join(DEFAULT_OUT_DIR, `${provider}.schema.json`);
  const outDoc = opts.outDoc ?? path.join(DEFAULT_OUT_DIR, `${provider}.md`);

  process.stderr.write(`[${provider}] scanning ${root}\n`);

  const extract = provider === "claude" ? extractClaude : extractGemini;
  const onProgress = (s: { filesScanned: number; filesTotal: number; recordsScanned: number }) => {
    if (s.filesScanned === 0 || s.filesScanned === s.filesTotal || s.filesScanned % 500 === 0) {
      process.stderr.write(
        `[${provider}] scanned ${s.filesScanned}/${s.filesTotal} files, ${s.recordsScanned} records\n`,
      );
    }
  };

  const artifact = await extract({ root, maxFiles: opts.maxFiles, onProgress });

  // Orphan-rate gate on declared edges
  const worstOrphan = artifact.references.reduce(
    (max, e) => Math.max(max, e.orphanRate),
    0,
  );
  if (!opts.check && worstOrphan > opts.maxOrphanRate) {
    process.stderr.write(
      `[${provider}] declared edge orphan rate ${(worstOrphan * 100).toFixed(2)}% exceeds --max-orphan-rate ${(opts.maxOrphanRate * 100).toFixed(2)}%\n`,
    );
    // Continue writing so the user can see the diff; but signal via exit code
    const worstViolations = artifact.invariants.reduce(
      (max, i) => Math.max(max, i.observedViolations ?? 0),
      0,
    );
    await writeArtifact(artifact, outSchema, outDoc);
    process.stdout.write(summaryLine(artifact, worstOrphan, worstViolations) + "\n");
    return 4;
  }

  const result = await writeOrCheck(artifact, outSchema, outDoc, opts.check);
  const worstViolations = artifact.invariants.reduce(
    (max, i) => Math.max(max, i.observedViolations ?? 0),
    0,
  );
  process.stdout.write(summaryLine(artifact, worstOrphan, worstViolations) + "\n");
  return result;
}

async function writeArtifact(
  artifact: SchemaArtifact,
  outSchema: string,
  outDoc: string,
): Promise<void> {
  await mkdir(path.dirname(outSchema), { recursive: true });
  await writeFile(outSchema, stableStringify(artifact), "utf-8");
  await writeFile(outDoc, emitMarkdown(artifact), "utf-8");
}

async function writeOrCheck(
  artifact: SchemaArtifact,
  outSchema: string,
  outDoc: string,
  check: boolean,
): Promise<number> {
  const schemaText = stableStringify(artifactForComparison(artifact));
  const docText = emitMarkdown(artifact);
  if (check) {
    const schemaExisting = await readFile(outSchema, "utf-8").catch(() => null);
    const docExisting = await readFile(outDoc, "utf-8").catch(() => null);
    const schemaMatch = schemaExisting !== null && stripExtractedAt(schemaExisting) === stripExtractedAt(schemaText);
    const docMatch = docExisting !== null && docExisting === docText;
    if (schemaMatch && docMatch) return 0;
    process.stderr.write(
      `[check] diff detected (schema=${schemaMatch ? "same" : "different"}, doc=${docMatch ? "same" : "different"})\n`,
    );
    return 3;
  }
  await mkdir(path.dirname(outSchema), { recursive: true });
  await writeFile(outSchema, stableStringify(artifact), "utf-8");
  await writeFile(outDoc, docText, "utf-8");
  return 0;
}

// extractedAt is the one non-deterministic field; stripped during --check so
// a timestamp difference doesn't fail the byte check.
function artifactForComparison(artifact: SchemaArtifact): SchemaArtifact {
  return {
    ...artifact,
    corpusMeta: { ...artifact.corpusMeta, extractedAt: "<normalized>" },
  };
}

function stripExtractedAt(text: string): string {
  return text.replace(/"extractedAt":\s*"[^"]*"/, '"extractedAt": "<normalized>"');
}

function summaryLine(
  artifact: SchemaArtifact,
  worstOrphanRate: number,
  worstInvariantViolations: number,
): string {
  return JSON.stringify({
    provider: artifact.corpusMeta.provider,
    filesScanned: artifact.corpusMeta.filesScanned,
    recordsScanned: artifact.corpusMeta.recordsScanned,
    parseErrors: artifact.corpusMeta.parseErrors,
    recordKinds: Object.keys(artifact.records).length,
    declaredEdges: artifact.references.length,
    suggestedEdges: artifact.suggestedReferences.length,
    worstOrphanRate,
    worstInvariantViolations,
  });
}

export async function main(argv: string[]): Promise<number> {
  let opts: CliOpts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const providers: ("claude" | "gemini")[] =
    opts.provider === "all" ? ["claude", "gemini"] : [opts.provider];

  let worst = 0;
  for (const p of providers) {
    try {
      const code = await runOne(p, opts);
      worst = Math.max(worst, code);
    } catch (err) {
      process.stderr.write(`[${p}] error: ${(err as Error).message}\n`);
      return 2;
    }
  }
  return worst;
}

// Run when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
