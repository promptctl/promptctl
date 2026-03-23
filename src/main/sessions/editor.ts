// [LAW:single-enforcer] All session loading, analysis, and trimming logic lives here.
import { readFile, writeFile, copyFile } from "node:fs/promises";
import type {
  GeminiMessageSummary,
  GeminiMessageFlag,
} from "../../shared/types";

// Raw JSON shape from Gemini CLI session files
interface RawSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: RawMessage[];
  kind: string;
  summary: string;
}

interface RawMessage {
  id: string;
  timestamp: string;
  type: string;
  content?: RawContent[];
  displayContent?: unknown[];
  [key: string]: unknown;
}

type RawContent =
  | { text: string }
  | { toolCalls: unknown[] }
  | { functionResponse: unknown }
  | Record<string, unknown>;

let loadedSession: RawSession | null = null;
let loadedPath: string | null = null;

export async function loadSession(filePath: string): Promise<GeminiMessageSummary[]> {
  const raw = await readFile(filePath, "utf-8");
  loadedSession = JSON.parse(raw) as RawSession;
  loadedPath = filePath;
  return summarizeMessages(loadedSession.messages);
}

export function getMessageContent(index: number): string {
  if (!loadedSession) return "";
  const msg = loadedSession.messages[index];
  if (!msg) return "";
  return JSON.stringify(msg, null, 2);
}

function summarizeMessages(messages: RawMessage[]): GeminiMessageSummary[] {
  return messages.map((msg, index) => {
    const sizeBytes = JSON.stringify(msg).length;
    const preview = extractPreview(msg);
    const flags = analyzeFlags(msg, sizeBytes);
    const hasToolCalls = hasToolCallContent(msg);
    const hasToolResults = hasToolResultContent(msg);

    return {
      index,
      id: msg.id,
      type: msg.type,
      timestamp: msg.timestamp,
      sizeBytes,
      preview,
      hasToolCalls,
      hasToolResults,
      flags,
    };
  });
}

function extractPreview(msg: RawMessage): string {
  const contents = msg.content ?? [];
  for (const c of contents) {
    if ("text" in c && typeof c.text === "string") {
      return c.text.slice(0, 300).replace(/\n/g, " ");
    }
    if ("toolCalls" in c) {
      const calls = c.toolCalls as Array<{ name?: string }>;
      const names = calls.map((tc) => tc.name ?? "unknown").join(", ");
      return `[tool calls: ${names}]`;
    }
  }
  return `[${msg.type}]`;
}

function hasToolCallContent(msg: RawMessage): boolean {
  const contents = msg.content ?? [];
  return contents.some((c) => "toolCalls" in c);
}

function hasToolResultContent(msg: RawMessage): boolean {
  const contents = msg.content ?? [];
  return contents.some(
    (c) => "functionResponse" in c || ("text" in c === false && "toolCalls" in c === false),
  );
}

function analyzeFlags(msg: RawMessage, sizeBytes: number): GeminiMessageFlag[] {
  const flags: GeminiMessageFlag[] = [];

  if (sizeBytes > 50_000) flags.push("oversized");

  if (msg.type === "info") flags.push("system-noise");

  // Check for tool outputs in message content
  const contents = msg.content ?? [];
  for (const c of contents) {
    if ("toolCalls" in c) {
      flags.push("tool-output");
      break;
    }
  }
  // Also check for tool results in displayContent
  const displayContents = (msg.displayContent ?? []) as RawContent[];
  for (const c of displayContents) {
    if ("functionResponse" in c) {
      flags.push("tool-output");
      break;
    }
  }

  // Detect repetition patterns
  const fullText = JSON.stringify(msg.content);
  if (detectRepetition(fullText)) flags.push("repetitive");

  // Detect loop detection messages
  if (fullText.toLowerCase().includes("loop detected")) {
    flags.push("loop-detection");
  }

  return flags;
}

function detectRepetition(text: string): boolean {
  if (text.length < 1000) return false;
  // Look for a phrase repeated many times
  const sample = text.slice(0, 5000);
  const phrases = sample.match(/(.{20,50})\1{3,}/);
  return phrases !== null;
}

export function autoTrimSuggestions(): number[] {
  if (!loadedSession) return [];
  const summaries = summarizeMessages(loadedSession.messages);
  const toRemove: Set<number> = new Set();

  for (const msg of summaries) {
    // Always flag repetitive / loop-detection
    if (msg.flags.includes("repetitive")) toRemove.add(msg.index);
    if (msg.flags.includes("loop-detection")) toRemove.add(msg.index);
    // Flag system noise
    if (msg.flags.includes("system-noise")) toRemove.add(msg.index);
  }

  return [...toRemove].sort((a, b) => a - b);
}

export async function saveSession(
  indicesToRemove: number[],
  outputPath?: string,
): Promise<string> {
  if (!loadedSession || !loadedPath) {
    throw new Error("No session loaded");
  }

  // Backup original
  const backupPath = loadedPath + ".backup";
  await copyFile(loadedPath, backupPath);

  const removeSet = new Set(indicesToRemove);
  const trimmedMessages = loadedSession.messages.filter(
    (_, i) => !removeSet.has(i),
  );

  const trimmedSession: RawSession = {
    ...loadedSession,
    messages: trimmedMessages,
    lastUpdated: new Date().toISOString(),
  };

  const dest = outputPath ?? loadedPath;
  await writeFile(dest, JSON.stringify(trimmedSession, null, 2), "utf-8");

  // Reload the trimmed version
  loadedSession = trimmedSession;
  loadedPath = dest;

  return dest;
}
