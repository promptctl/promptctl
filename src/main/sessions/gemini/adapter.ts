// [LAW:single-enforcer] All Gemini session discovery, loading, analysis, and trimming.
// [LAW:one-source-of-truth] Project names come from ~/.gemini/projects.json.
// Session files live under ~/.gemini/tmp/<folder>/chats/*.json.
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Project, SessionInfo, MessageSummary, DiffEntry } from "../../../shared/types";
import type { ProviderAdapter } from "../types";
import { countTokens } from "../tokenizer";
import type { RawSession, RawMessage, RawContent } from "./types";

export type { RawSession, RawMessage, RawContent } from "./types";

// --- Internal helpers ---

const GEMINI_HOME = path.join(process.env.HOME ?? "", ".gemini");
const GEMINI_TMP = path.join(GEMINI_HOME, "tmp");

function contentArray(msg: RawMessage): RawContent[] {
  if (typeof msg.content === "string") return [{ text: msg.content }];
  return msg.content ?? [];
}

function extractPreview(msg: RawMessage): string {
  const contents = contentArray(msg);
  for (const c of contents) {
    if ("text" in c && typeof c.text === "string") {
      return c.text.slice(0, 300).replace(/\n/g, " ");
    }
  }
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    const calls = msg.toolCalls as { name?: string }[];
    const names = calls.map((tc) => tc.name ?? "unknown").join(", ");
    return `[tool calls: ${names}]`;
  }
  return `[${msg.type}]`;
}

function extractText(msg: RawMessage): string {
  const role = msg.type === "user" ? "User" : msg.type === "gemini" ? "Assistant" : msg.type;
  const parts: string[] = [];
  for (const c of contentArray(msg)) {
    if ("text" in c && typeof c.text === "string") {
      parts.push(c.text);
    }
  }
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    const calls = msg.toolCalls as { name?: string }[];
    for (const tc of calls) {
      parts.push(`[Tool call: ${tc.name ?? "unknown"}]`);
    }
  }
  const body = parts.join("\n").trim();
  return body ? `**${role}:**\n${body}` : "";
}

function extractToolNames(msg: RawMessage): string[] {
  if (!("toolCalls" in msg) || !Array.isArray(msg.toolCalls)) return [];
  const calls = msg.toolCalls as { name?: string }[];
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
  const contents = contentArray(msg);
  const display = (msg.displayContent ?? []) as RawContent[];
  return [...contents, ...display].some((c) => "functionResponse" in c);
}

function detectRepetition(text: string): boolean {
  if (text.length < 1000) return false;
  const sample = text.slice(0, 5000);
  const phrases = sample.match(/(.{20,50})\1{3,}/);
  return phrases !== null;
}

function analyzeFlags(msg: RawMessage, tokens: number): string[] {
  const flags: string[] = [];
  if (tokens > 10_000) flags.push("oversized");
  if (msg.type === "info") flags.push("system-noise");
  if ("toolCalls" in msg && Array.isArray(msg.toolCalls)) {
    flags.push("tool-output");
  }
  const fullText = JSON.stringify(contentArray(msg));
  if (detectRepetition(fullText)) flags.push("repetitive");
  if (fullText.toLowerCase().includes("loop detected")) {
    flags.push("loop-detection");
  }
  return flags;
}

function summarizeMessages(messages: RawMessage[]): MessageSummary[] {
  return messages.map((msg, index) => {
    const serialized = JSON.stringify(msg);
    const tokens = countTokens(serialized);
    return {
      index,
      id: msg.id,
      type: msg.type,
      timestamp: msg.timestamp,
      tokens,
      preview: extractPreview(msg),
      hasToolCalls: hasToolCallContent(msg),
      hasToolResults: hasToolResultContent(msg),
      toolNames: extractToolNames(msg),
      flags: analyzeFlags(msg, tokens),
      extras: {},
    };
  });
}

// [LAW:one-source-of-truth] projects.json is the canonical path→name map.
async function loadProjectNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await readFile(
      path.join(GEMINI_HOME, "projects.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    const projects = data.projects ?? data;
    for (const [projectRoot, folderName] of Object.entries(projects)) {
      if (typeof folderName === "string") {
        map.set(folderName, projectRoot);
      }
    }
  } catch {
    // No projects.json — fall back to .project_root files only
  }
  return map;
}

// --- Adapter state ---

let loadedSession: RawSession | null = null;
let loadedPath: string | null = null;

// --- Adapter implementation ---

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",

  uiMetadata: {
    badge: { label: "Gemini", color: "bg-blue-500/20 text-blue-400" },
    typeStyles: {
      user: { label: "User", color: "bg-blue-500/20 text-blue-400" },
      gemini: { label: "Gemini", color: "bg-emerald-500/20 text-emerald-400" },
      info: { label: "Info", color: "bg-neutral-500/20 text-neutral-400" },
    },
    flagDefinitions: {
      oversized: {
        label: "LARGE",
        color: "text-orange-400 bg-orange-500/20",
        tip: "Over 10k tokens. Usually a large tool output (file read, search result). Safe to cut if the model already summarized its contents.",
      },
      repetitive: {
        label: "REPEAT",
        color: "text-red-400 bg-red-500/20",
        tip: "Contains repeated phrases. Likely a model loop / degenerate output. Almost always safe to remove.",
      },
      "loop-detection": {
        label: "LOOP",
        color: "text-red-400 bg-red-500/20",
        tip: "System loop-detection message. The conversation crashed here. Remove this and the messages around it.",
      },
      "tool-output": {
        label: "TOOL",
        color: "text-neutral-400 bg-neutral-700",
        tip: "Contains tool calls or results. Review before cutting — the model may reference these results later.",
      },
      "system-noise": {
        label: "NOISE",
        color: "text-neutral-500 bg-neutral-800",
        tip: "System/info message with no conversational value. Safe to remove.",
      },
    },
    helpText: {
      description:
        "Gemini CLI stores conversations as a JSON array of messages. The model has a context window — when a session gets too long, older messages get pushed out. Trimming removes low-value messages to keep important context in the window longer.",
      resumeCommand: "gemini --resume latest",
      safeToRemove: [
        "REPEAT / LOOP — degenerate output, always safe",
        "NOISE — system metadata with no value",
        "LARGE tool outputs already summarized by the model",
      ],
      beCareful: [
        "User messages — these are your instructions",
        "Messages the model explicitly references later",
        "Tool results the model builds on in subsequent messages",
      ],
    },
  },

  async listProjects(): Promise<Project[]> {
    const [entries, folderToRoot] = await Promise.all([
      readdir(GEMINI_TMP, { withFileTypes: true }).catch(() => []),
      loadProjectNames(),
    ]);

    const byName = new Map<string, { projectRoot: string; dirs: string[] }>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(GEMINI_TMP, entry.name);

      const projectRoot = await readFile(
        path.join(projectDir, ".project_root"),
        "utf-8",
      )
        .then((raw) => raw.trim())
        .catch(() => folderToRoot.get(entry.name) ?? "");

      const displayName = projectRoot.startsWith("/")
        ? path.basename(projectRoot)
        : "";
      if (!displayName) continue;

      const chatsDir = path.join(projectDir, "chats");
      let hasSessions = false;
      try {
        const chatFiles = await readdir(chatsDir);
        hasSessions = chatFiles.some((f) => f.endsWith(".json"));
      } catch {
        // no chats dir
      }
      if (!hasSessions) continue;

      const existing = byName.get(displayName);
      if (existing) {
        existing.dirs.push(projectDir);
      } else {
        byName.set(displayName, { projectRoot, dirs: [projectDir] });
      }
    }

    const projects: Project[] = [];
    for (const [name, { projectRoot, dirs }] of byName) {
      projects.push({ name, paths: dirs, projectRoot, provider: "gemini" });
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  },

  async listSessions(projectPaths: string[]): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const seenIds = new Set<string>();

    for (const projectPath of projectPaths) {
      const chatsDir = path.join(projectPath, "chats");
      let entries: string[];
      try {
        entries = await readdir(chatsDir);
      } catch {
        continue;
      }

      for (const filename of entries) {
        if (!filename.endsWith(".json")) continue;
        if (filename.includes("backup")) continue;

        const filePath = path.join(chatsDir, filename);
        try {
          const fileStat = await stat(filePath);
          const raw = await readFile(filePath, "utf-8");
          const data = JSON.parse(raw);

          const sessionId = data.sessionId ?? filename;
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);

          const previewMessages: string[] = [];
          const msgs = data.messages ?? [];
          for (const msg of msgs) {
            if (previewMessages.length >= 3) break;
            if (msg.type !== "user") continue;
            const content = msg.content;
            if (typeof content === "string") {
              if (content.length > 5) {
                previewMessages.push(
                  content.slice(0, 200).replace(/\n/g, " "),
                );
              }
              continue;
            }
            const contents = content ?? [];
            for (const c of contents) {
              if (
                typeof c === "object" &&
                c !== null &&
                "text" in c &&
                typeof c.text === "string" &&
                c.text.length > 5
              ) {
                previewMessages.push(
                  c.text.slice(0, 200).replace(/\n/g, " "),
                );
                break;
              }
            }
          }

          sessions.push({
            sessionId,
            filePath,
            summary: data.summary ?? "",
            startTime: data.startTime ?? "",
            lastUpdated: data.lastUpdated ?? "",
            messageCount: msgs.length,
            fileSizeBytes: fileStat.size,
            previewMessages,
          });
        } catch {
          // Skip files that fail to parse
        }
      }
    }

    sessions.sort(
      (a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    );
    return sessions;
  },

  // Scan projects for a matching session id. Gemini sessions are few per project,
  // so the naive scan is fine.
  async findSession(sessionId: string) {
    const projects = await this.listProjects();
    for (const project of projects) {
      const sessions = await this.listSessions(project.paths);
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (session) return { project, session };
    }
    return null;
  },

  async loadSession(filePath: string): Promise<MessageSummary[]> {
    const raw = await readFile(filePath, "utf-8");
    loadedSession = JSON.parse(raw) as RawSession;
    loadedPath = filePath;
    return summarizeMessages(loadedSession.messages);
  },

  summarizeContent(content: string): MessageSummary[] {
    try {
      const parsed = JSON.parse(content) as RawSession;
      return summarizeMessages(parsed.messages ?? []);
    } catch {
      return [];
    }
  },

  getMessageContent(index: number): string {
    if (!loadedSession) return "";
    const msg = loadedSession.messages[index];
    if (!msg) return "";
    return JSON.stringify(msg, null, 2);
  },

  getMessageRaw(index: number): unknown {
    if (!loadedSession) return null;
    return loadedSession.messages[index] ?? null;
  },

  getMessagesContent(indices: number[]): string {
    const session = loadedSession;
    if (!session) return "";
    const sorted = [...indices].sort((a, b) => a - b);
    return sorted
      .map((i) => {
        const msg = session.messages[i];
        if (!msg) return "";
        return extractText(msg);
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  },

  autoTrimSuggestions(): number[] {
    if (!loadedSession) return [];
    const summaries = summarizeMessages(loadedSession.messages);
    const toRemove = new Set<number>();
    for (const msg of summaries) {
      if (msg.flags.includes("repetitive")) toRemove.add(msg.index);
      if (msg.flags.includes("loop-detection")) toRemove.add(msg.index);
      if (msg.flags.includes("system-noise")) toRemove.add(msg.index);
    }
    return [...toRemove].sort((a, b) => a - b);
  },

  async saveSession(
    indicesToRemove: number[],
    outputPath?: string,
  ): Promise<string> {
    if (!loadedSession || !loadedPath) {
      throw new Error("No session loaded");
    }

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

    loadedSession = trimmedSession;
    loadedPath = dest;

    return dest;
  },

  diffContent(oldContent: string, newContent: string): DiffEntry[] {
    let oldMsgs: RawMessage[] = [];
    let newMsgs: RawMessage[] = [];
    try {
      oldMsgs = (JSON.parse(oldContent) as RawSession).messages ?? [];
    } catch {
      // malformed → treat as empty
    }
    try {
      newMsgs = (JSON.parse(newContent) as RawSession).messages ?? [];
    } catch {
      // malformed → treat as empty
    }

    const oldSummaries = summarizeMessages(oldMsgs);
    const newSummaries = summarizeMessages(newMsgs);

    // Match by id (Gemini messages have stable ids); positional fallback
    const oldByKey = new Map<string, { msg: RawMessage; summary: MessageSummary; pos: number }>();
    const newByKey = new Map<string, { msg: RawMessage; summary: MessageSummary; pos: number }>();
    const keyOf = (msg: RawMessage, pos: number): string => msg.id ?? `pos:${pos}`;

    oldMsgs.forEach((msg, pos) =>
      oldByKey.set(keyOf(msg, pos), { msg, summary: oldSummaries[pos], pos }),
    );
    newMsgs.forEach((msg, pos) =>
      newByKey.set(keyOf(msg, pos), { msg, summary: newSummaries[pos], pos }),
    );

    const entries: DiffEntry[] = [];
    let unchangedRun = 0;
    const flushUnchanged = () => {
      if (unchangedRun > 0) {
        entries.push({ kind: "unchanged", count: unchangedRun });
        unchangedRun = 0;
      }
    };

    const seenOldKeys = new Set<string>();

    for (let i = 0; i < newMsgs.length; i++) {
      const newItem = { msg: newMsgs[i], summary: newSummaries[i], pos: i };
      const key = keyOf(newItem.msg, i);
      const oldItem = oldByKey.get(key);

      if (!oldItem) {
        flushUnchanged();
        entries.push({ kind: "added", messages: [newItem.summary] });
        continue;
      }
      seenOldKeys.add(key);

      if (JSON.stringify(oldItem.msg) === JSON.stringify(newItem.msg)) {
        unchangedRun++;
      } else {
        flushUnchanged();
        entries.push({
          kind: "modified",
          before: oldItem.summary,
          after: newItem.summary,
        });
      }
    }
    flushUnchanged();

    const removed: MessageSummary[] = [];
    oldMsgs.forEach((msg, pos) => {
      const key = keyOf(msg, pos);
      if (!seenOldKeys.has(key)) {
        removed.push(oldSummaries[pos]);
      }
    });
    if (removed.length > 0) {
      entries.push({ kind: "removed", messages: removed });
    }

    return entries;
  },
};
