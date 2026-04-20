// Extractor for Gemini CLI JSON session files. One JSON object per session,
// observed as two record kinds: GeminiSession (top-level) and GeminiMessage
// (members of session.messages[]).

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RawMessage, RawSession } from "../../src/main/sessions/gemini/types";
import { SchemaAccumulator } from "./core/accumulator";
import {
  GEMINI_EDGES,
  indexValue,
  suggestEdges,
  verifyDeclaredEdges,
  type ValueIndex,
} from "./core/edges";
import { GEMINI_INVARIANTS } from "./core/invariants";
import type {
  Invariant,
  SchemaArtifact,
} from "./core/types";

export const GEMINI_EXTRACTOR_VERSION = "1";

export interface ExtractOptions {
  root: string;
  maxFiles?: number;
  onProgress?: (stats: { filesScanned: number; filesTotal: number; recordsScanned: number }) => void;
}

export async function extractGemini(opts: ExtractOptions): Promise<SchemaArtifact> {
  const accum = new SchemaAccumulator();
  const valueIndex: ValueIndex = new Map();
  const fromValues = new Map<string, string[]>();

  let filesScanned = 0;
  let recordsScanned = 0;
  let parseErrors = 0;
  const invariantStats = new Map<string, { violations: number; samples: string[] }>();
  for (const inv of GEMINI_INVARIANTS) {
    invariantStats.set(inv.id, { violations: 0, samples: [] });
  }

  const files = await collectJsonFiles(opts.root);
  files.sort();
  const filesToScan = opts.maxFiles ? files.slice(0, opts.maxFiles) : files;

  for (const filePath of filesToScan) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      parseErrors++;
      continue;
    }
    let session: RawSession;
    try {
      session = JSON.parse(raw) as RawSession;
    } catch {
      parseErrors++;
      continue;
    }
    recordsScanned++;
    accum.observeRecord(
      "GeminiSession",
      session as unknown as Record<string, unknown>,
    );
    visit(session as unknown as Record<string, unknown>, "GeminiSession", valueIndex, fromValues, new Set(["messages"]));

    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      recordsScanned++;
      accum.observeRecord("GeminiMessage", msg as unknown as Record<string, unknown>, "type");
      visit(msg as unknown as Record<string, unknown>, "GeminiMessage", valueIndex, fromValues);
    }
    verifyInvariants(session, messages, filePath, invariantStats);
    filesScanned++;
    opts.onProgress?.({ filesScanned, filesTotal: filesToScan.length, recordsScanned });
  }

  const records = accum.finalize();
  const references = verifyDeclaredEdges(GEMINI_EDGES, fromValues, valueIndex);
  const suggestedReferences = suggestEdges(valueIndex, GEMINI_EDGES);

  const invariants: Invariant[] = GEMINI_INVARIANTS.map((inv) => {
    const stats = invariantStats.get(inv.id);
    return {
      ...inv,
      observedViolations: stats?.violations ?? 0,
      observedSamples: stats?.samples.slice(0, 3),
    };
  });

  return {
    corpusMeta: {
      provider: "gemini",
      corpusRoot: opts.root,
      filesScanned,
      recordsScanned,
      parseErrors,
      extractedAt: new Date().toISOString(),
      extractorVersion: GEMINI_EXTRACTOR_VERSION,
    },
    records,
    references,
    suggestedReferences,
    invariants,
  };
}

async function collectJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  for (const d of dirs.sort()) {
    const projectDir = path.join(root, d);
    const dirStat = await stat(projectDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;
    const chatsDir = path.join(projectDir, "chats");
    const chats = await readdir(chatsDir).catch(() => []);
    for (const f of chats.sort()) {
      if (typeof f !== "string" || !f.endsWith(".json")) continue;
      out.push(path.join(chatsDir, f));
    }
  }
  return out;
}

function visit(
  obj: unknown,
  pathSoFar: string,
  toIndex: ValueIndex,
  fromValues: Map<string, string[]>,
  skipFields: Set<string> = new Set(),
): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (skipFields.has(k)) continue;
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

function verifyInvariants(
  session: RawSession,
  messages: RawMessage[],
  filePath: string,
  stats: Map<string, { violations: number; samples: string[] }>,
): void {
  const shapeStats = stats.get("session_object_shape");
  if (shapeStats) {
    const required = [
      "sessionId",
      "projectHash",
      "startTime",
      "lastUpdated",
      "kind",
      "summary",
    ];
    const missing = required.filter(
      (f) => !(f in (session as unknown as Record<string, unknown>)),
    );
    if (missing.length > 0) {
      shapeStats.violations++;
      if (shapeStats.samples.length < 3) {
        shapeStats.samples.push(
          `missing [${missing.join(",")}] at ${path.basename(filePath)}`,
        );
      }
    }
  }

  const idStats = stats.get("message_id_stability");
  if (idStats) {
    const ids = new Set<string>();
    for (const msg of messages) {
      const id = (msg as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) {
        idStats.violations++;
        if (idStats.samples.length < 3) {
          idStats.samples.push(`message missing id in ${path.basename(filePath)}`);
        }
        continue;
      }
      if (ids.has(id)) {
        idStats.violations++;
        if (idStats.samples.length < 3) {
          idStats.samples.push(`duplicate id=${id} in ${path.basename(filePath)}`);
        }
      }
      ids.add(id);
    }
  }
}
