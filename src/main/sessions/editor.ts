// [LAW:single-enforcer] All session loading, analysis, and trimming logic lives here.
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
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
  content?: string | RawContent[];
  displayContent?: unknown[];
  [key: string]: unknown;
}

type RawContent =
  | { text: string }
  | { toolCalls: unknown[] }
  | { functionResponse: unknown }
  | Record<string, unknown>;

function contentArray(msg: RawMessage): RawContent[] {
  if (typeof msg.content === "string") return [{ text: msg.content }];
  return msg.content ?? [];
}

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

function extractText(msg: RawMessage): string {
  const role = msg.type === "user" ? "User" : msg.type === "gemini" ? "Assistant" : msg.type;
  const parts: string[] = [];
  for (const c of contentArray(msg)) {
    if ("text" in c && typeof c.text === "string") {
      parts.push(c.text);
    }
  }
  // toolCalls is a top-level message key
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    const calls = msg.toolCalls as Array<{ name?: string }>;
    for (const tc of calls) {
      parts.push(`[Tool call: ${tc.name ?? "unknown"}]`);
    }
  }
  const body = parts.join("\n").trim();
  return body ? `**${role}:**\n${body}` : "";
}

export function getMessagesContent(indices: number[]): string {
  if (!loadedSession) return "";
  const sorted = [...indices].sort((a, b) => a - b);
  return sorted
    .map((i) => {
      const msg = loadedSession!.messages[i];
      if (!msg) return "";
      return extractText(msg);
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function summarizeMessages(messages: RawMessage[]): GeminiMessageSummary[] {
  return messages.map((msg, index) => {
    const sizeBytes = JSON.stringify(msg).length;
    const preview = extractPreview(msg);
    const flags = analyzeFlags(msg, sizeBytes);
    const hasToolCalls = hasToolCallContent(msg);
    const hasToolResults = hasToolResultContent(msg);
    const toolNames = extractToolNames(msg);

    return {
      index,
      id: msg.id,
      type: msg.type,
      timestamp: msg.timestamp,
      sizeBytes,
      preview,
      hasToolCalls,
      hasToolResults,
      toolNames,
      flags,
    };
  });
}

function extractPreview(msg: RawMessage): string {
  const contents = contentArray(msg);
  for (const c of contents) {
    if ("text" in c && typeof c.text === "string") {
      return c.text.slice(0, 300).replace(/\n/g, " ");
    }
  }
  // toolCalls is a top-level message key
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    const calls = msg.toolCalls as Array<{ name?: string }>;
    const names = calls.map((tc) => tc.name ?? "unknown").join(", ");
    return `[tool calls: ${names}]`;
  }
  return `[${msg.type}]`;
}

function extractToolNames(msg: RawMessage): string[] {
  if (!("toolCalls" in msg) || !Array.isArray(msg.toolCalls)) return [];
  const calls = msg.toolCalls as Array<{ name?: string }>;
  const names = new Set<string>();
  for (const tc of calls) {
    if (tc.name) names.add(tc.name);
  }
  return [...names];
}

function hasToolCallContent(msg: RawMessage): boolean {
  return "toolCalls" in msg && Array.isArray(msg.toolCalls);
}

function hasToolResultContent(msg: RawMessage): boolean {
  // Tool results appear as functionResponse in content or displayContent
  const contents = contentArray(msg);
  const display = (msg.displayContent ?? []) as RawContent[];
  return [...contents, ...display].some((c) => "functionResponse" in c);
}

function analyzeFlags(msg: RawMessage, sizeBytes: number): GeminiMessageFlag[] {
  const flags: GeminiMessageFlag[] = [];

  if (sizeBytes > 50_000) flags.push("oversized");

  if (msg.type === "info") flags.push("system-noise");

  // toolCalls is a top-level message key in Gemini's format
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    flags.push("tool-output");
  }

  // Detect repetition patterns
  const fullText = JSON.stringify(contentArray(msg));
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

export async function checkBackupExists(): Promise<{ exists: boolean; path: string; size: number }> {
  if (!loadedPath) return { exists: false, path: "", size: 0 };
  const backupPath = loadedPath + ".backup";
  try {
    const s = await stat(backupPath);
    return { exists: true, path: backupPath, size: s.size };
  } catch {
    return { exists: false, path: backupPath, size: 0 };
  }
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
