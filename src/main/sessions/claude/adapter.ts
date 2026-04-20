// [LAW:single-enforcer] All Claude Code session discovery, loading, analysis, and trimming.
// [LAW:one-source-of-truth] Project paths extracted from cwd in session JSONL files.
// Session files live under ~/.claude/projects/<encoded-path>/<sessionId>.jsonl.
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  Project,
  SessionInfo,
  MessageSummary,
  DiffEntry,
  CompressToolsOptions,
  CompressToolsResult,
} from "../../../shared/types";
import type { ProviderAdapter } from "../types";
import type { TaskHandle } from "../../tasks/runner";
import { countTokens, truncateMiddle } from "../tokenizer";
import { chatComplete } from "../../llm/client";
import type { ClaudeLine } from "./types";

export type { ClaudeLine, ClaudeContentBlock } from "./types";

// --- Internal helpers ---

const CLAUDE_PROJECTS = path.join(process.env.HOME ?? "", ".claude", "projects");

// Which JSONL line types are visible as messages in the editor
const VISIBLE_TYPES = new Set(["user", "assistant", "system"]);

function isVisibleMessage(line: ClaudeLine): boolean {
  return VISIBLE_TYPES.has(line.type) && line.isSidechain !== true;
}

function userTextContent(line: ClaudeLine): string | null {
  if (line.type !== "user") return null;
  const msg = line.message;
  if (msg?.role !== "user") return null;
  return typeof msg.content === "string" ? msg.content : null;
}

function extractTextPreview(line: ClaudeLine): string {
  const msg = line.message;
  if (!msg) return `[${line.type}]`;

  // User message with string content
  if (typeof msg.content === "string") {
    return msg.content.slice(0, 300).replace(/\n/g, " ");
  }

  // Assistant message with content blocks — prefer text, fall back to tool names
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text.slice(0, 300).replace(/\n/g, " ");
      }
    }
    // Tool result blocks — show their content (truncated)
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        return text.slice(0, 300).replace(/\n/g, " ");
      }
    }
    // No text blocks — summarize tool calls
    const toolNames = msg.content
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => b.name);
    if (toolNames.length > 0) {
      return `[tools: ${toolNames.join(", ")}]`;
    }
    // Thinking-only blocks
    const hasThinking = msg.content.some((b) => b.type === "thinking");
    if (hasThinking) {
      return "[thinking]";
    }
  }

  // System messages
  const content = line.content;
  if (typeof content === "string") {
    return content.slice(0, 300).replace(/\n/g, " ");
  }

  return `[${line.type}]`;
}

function extractFormattedText(line: ClaudeLine): string {
  const msg = line.message;
  if (!msg) return "";

  const role =
    line.type === "user" ? "User" : line.type === "assistant" ? "Assistant" : line.type;
  const parts: string[] = [];

  if (typeof msg.content === "string") {
    parts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use" && block.name) {
        parts.push(`[Tool call: ${block.name}]`);
      }
    }
  }

  const body = parts.join("\n").trim();
  return body ? `**${role}:**\n${body}` : "";
}

function extractToolNames(line: ClaudeLine): string[] {
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  const names = new Set<string>();
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      names.add(block.name);
    }
  }
  return [...names];
}

function hasToolCalls(line: ClaudeLine): boolean {
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type === "tool_use");
}

function hasToolResults(line: ClaudeLine): boolean {
  if (line.toolUseResult != null) return true;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type === "tool_result");
}

function detectRepetition(text: string): boolean {
  if (text.length < 1000) return false;
  const sample = text.slice(0, 5000);
  const phrases = sample.match(/(.{20,50})\1{3,}/);
  return phrases !== null;
}

// [LAW:one-source-of-truth] Billable input tokens = only content the API charges on re-send.
// Thinking blocks are stripped automatically by the API and never charged as input.
function extractBillableText(line: ClaudeLine): string {
  const msg = line.message;
  if (!msg) return "";

  // User message with string content
  if (typeof msg.content === "string") return msg.content;

  // Content block array — include text, tool_use, tool_result; exclude thinking
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "thinking") continue; // free — API strips these
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        // Tool name + serialized input contribute to token count
        parts.push(block.name ?? "");
        if (block.input != null) parts.push(JSON.stringify(block.input));
      } else if (block.type === "tool_result") {
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join("\n");
  }

  // System messages with top-level content
  const content = line.content;
  if (typeof content === "string") return content;

  return "";
}

function isThinkingOnly(line: ClaudeLine): boolean {
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every((b) => b.type === "thinking");
}

function classifyMessageType(line: ClaudeLine): string {
  if (line.type === "assistant") return "assistant";
  if (line.type === "system") return "system";
  // User lines: distinguish text messages from tool results
  if (line.type === "user") {
    if (hasToolResults(line)) return "tool-result";
    return "user";
  }
  return line.type;
}

function analyzeFlags(line: ClaudeLine, tokens: number): string[] {
  const flags: string[] = [];
  if (isThinkingOnly(line)) flags.push("thinking");
  if (tokens > 10_000) flags.push("oversized");
  if (line.type === "system") flags.push("system-noise");
  if (hasToolCalls(line)) flags.push("tool-output");

  const serialized = JSON.stringify(line.message?.content ?? "");
  if (detectRepetition(serialized)) flags.push("repetitive");

  return flags;
}

function buildExtras(line: ClaudeLine): Record<string, string> {
  const extras: Record<string, string> = {};
  const msg = line.message;

  if (line.type === "assistant" && msg) {
    if (msg.model) {
      // Shorten model name for display
      extras.model = msg.model
        .replace("claude-", "")
        .replace(/-\d{8}$/, "");
    }
    if (msg.usage) {
      // Total input = input_tokens + cache_creation + cache_read
      const usage = msg.usage as Record<string, unknown>;
      const inp =
        (msg.usage.input_tokens ?? 0) +
        ((usage.cache_creation_input_tokens as number) ?? 0) +
        ((usage.cache_read_input_tokens as number) ?? 0);
      const out = msg.usage.output_tokens ?? 0;
      extras.tokens = `${(inp / 1000).toFixed(1)}k in / ${(out / 1000).toFixed(1)}k out`;
    }
  }

  return extras;
}

// Builds a MessageSummary from a parsed line and its index. Reused across loadSession,
// compressToolResults, and diffContent so the same summary shape is produced everywhere.
function buildSummary(
  parsed: ClaudeLine,
  logicalIndex: number,
  physIdx: number,
): MessageSummary {
  const tokens = countTokens(extractBillableText(parsed));
  return {
    index: logicalIndex,
    id: parsed.uuid ?? `line-${physIdx}`,
    type: classifyMessageType(parsed),
    timestamp: parsed.timestamp ?? "",
    tokens,
    preview: extractTextPreview(parsed),
    hasToolCalls: hasToolCalls(parsed),
    hasToolResults: hasToolResults(parsed),
    toolNames: extractToolNames(parsed),
    flags: analyzeFlags(parsed, tokens),
    extras: buildExtras(parsed),
  };
}

// Parses content into [parsed, physicalIndex] pairs for visible messages only.
function parseVisibleMessages(content: string): {
  parsed: ClaudeLine;
  physIdx: number;
}[] {
  const lines = content.split("\n");
  const visible: { parsed: ClaudeLine; physIdx: number }[] = [];
  for (let physIdx = 0; physIdx < lines.length; physIdx++) {
    const raw = lines[physIdx];
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as ClaudeLine;
      if (isVisibleMessage(parsed)) {
        visible.push({ parsed, physIdx });
      }
    } catch {
      // skip malformed lines
    }
  }
  return visible;
}

// --- Discovery helpers ---

/** Extract the real project path from a Claude project directory by reading session files. */
async function extractProjectPath(projectDir: string): Promise<string | null> {
  // Read the first .jsonl file and find the first user message with cwd
  const files = await readdir(projectDir).catch(() => []);
  for (const f of files) {
    if (typeof f !== "string" || !f.endsWith(".jsonl")) continue;
    try {
      const content = await readFile(path.join(projectDir, f), "utf-8");
      for (const rawLine of content.split("\n")) {
        if (!rawLine.trim()) continue;
        const parsed = JSON.parse(rawLine) as ClaudeLine;
        if (parsed.type === "user" && parsed.cwd) {
          return parsed.cwd;
        }
      }
    } catch {
      // Skip files that fail to parse
    }
  }
  return null;
}

// Minimal SessionInfo build for a single known JSONL file. Used by findSession
// to avoid rescanning every project.
async function buildSessionInfoForFile(
  filePath: string,
  fileSizeBytes: number,
): Promise<SessionInfo> {
  const filename = path.basename(filePath);
  let sessionId = filename.replace(/\.jsonl$/, "");
  let summary = "";
  let startTime = "";
  let lastUpdated = "";
  let messageCount = 0;
  const previewMessages: string[] = [];

  const content = await readFile(filePath, "utf-8").catch(() => "");
  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) continue;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(rawLine) as ClaudeLine;
    } catch {
      continue;
    }
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.type === "custom-title" && parsed.customTitle) {
      summary = parsed.customTitle;
    }
    if (parsed.timestamp) {
      if (!startTime) startTime = parsed.timestamp;
      lastUpdated = parsed.timestamp;
    }
    if (isVisibleMessage(parsed)) messageCount++;
    if (previewMessages.length < 3) {
      const text = userTextContent(parsed);
      if (text !== null && text.length > 5) {
        previewMessages.push(text.slice(0, 200).replace(/\n/g, " "));
      }
    }
  }
  if (!summary && previewMessages.length > 0) {
    summary = previewMessages[0].slice(0, 80);
  }
  return {
    sessionId,
    filePath,
    summary,
    startTime,
    lastUpdated,
    messageCount,
    fileSizeBytes,
    previewMessages,
  };
}

// --- Adapter state ---

let loadedLines: string[] = [];
let loadedParsed: ClaudeLine[] = [];
let physicalLineMap: number[] = []; // physicalLineMap[logicalIndex] = physical line number
let loadedPath: string | null = null;

// [LAW:one-source-of-truth] Single definition of "what saveSession writes" —
// used both by previewSaveContent (no I/O, for pre-save validation) and by
// saveSession itself. Keeping the logic in one place means the validator can
// never see a different content than what lands on disk.
function computeSaveContent(indicesToRemove: number[]): string {
  if (!loadedPath) {
    throw new Error("No session loaded");
  }
  const physicalToRemove = new Set(
    indicesToRemove.map((i) => physicalLineMap[i]),
  );
  const trimmedLines = loadedLines.filter((_, i) => !physicalToRemove.has(i));
  return trimmedLines.join("\n");
}


// --- Adapter implementation ---

export const claudeAdapter: ProviderAdapter = {
  id: "claude",

  uiMetadata: {
    badge: { label: "Claude", color: "bg-orange-500/20 text-orange-400" },
    typeStyles: {
      user: { label: "User", color: "bg-blue-500/20 text-blue-400" },
      assistant: { label: "Claude", color: "bg-orange-500/20 text-orange-400" },
      "tool-result": {
        label: "Tool Result",
        color: "bg-neutral-500/20 text-neutral-400",
      },
      system: { label: "System", color: "bg-neutral-500/20 text-neutral-400" },
    },
    flagDefinitions: {
      thinking: {
        label: "THINKING",
        color: "text-purple-400 bg-purple-500/20",
        tip: "Thinking-only message.",
      },
      oversized: {
        label: "LARGE",
        color: "text-orange-400 bg-orange-500/20",
        tip: "Over 10k tokens. Usually a large tool output. Safe to cut if the model already summarized its contents.",
      },
      repetitive: {
        label: "REPEAT",
        color: "text-red-400 bg-red-500/20",
        tip: "Contains repeated phrases. Likely a model loop / degenerate output. Almost always safe to remove.",
      },
      "tool-output": {
        label: "TOOL",
        color: "text-neutral-400 bg-neutral-700",
        tip: "Contains tool calls or results. Review before cutting \u2014 the model may reference these results later.",
      },
      "system-noise": {
        label: "NOISE",
        color: "text-neutral-500 bg-neutral-800",
        tip: "System message with no conversational value. Safe to remove.",
      },
    },
    helpText: {
      description:
        "Extract core context from old conversations to seed new ones cheaply. Claude Code stores conversations as JSONL — trimming removes low-value messages so you keep only what matters. Continue the edited session with `claude --continue` at zero marginal cost.",
      resumeCommand: "claude --continue",
      safeToRemove: [
        "REPEAT \u2014 degenerate model output",
        "NOISE \u2014 system metadata",
        "LARGE tool outputs already summarized by the model",
        "THINKING \u2014 thinking-only messages",
      ],
      beCareful: [
        "User messages \u2014 these are your instructions",
        "Messages referenced by later conversation",
        "Tool results the model builds on",
      ],
    },
  },

  async listProjects(): Promise<Project[]> {
    let entries: string[];
    try {
      entries = await readdir(CLAUDE_PROJECTS);
    } catch {
      return [];
    }

    // Group directories by their resolved project path
    const byRoot = new Map<string, { dirs: string[] }>();

    await Promise.all(
      entries.map(async (dirName) => {
        const fullDir = path.join(CLAUDE_PROJECTS, dirName);
        const dirStat = await stat(fullDir).catch(() => null);
        if (!dirStat?.isDirectory()) return;

        // Check for .jsonl files
        const dirFiles = await readdir(fullDir).catch(() => []);
        const hasJsonl = dirFiles.some(
          (f) => typeof f === "string" && f.endsWith(".jsonl"),
        );
        if (!hasJsonl) return;

        const projectPath = await extractProjectPath(fullDir);
        if (!projectPath) return;

        const existing = byRoot.get(projectPath);
        if (existing) {
          existing.dirs.push(fullDir);
        } else {
          byRoot.set(projectPath, { dirs: [fullDir] });
        }
      }),
    );

    const projects: Project[] = [];
    for (const [projectRoot, { dirs }] of byRoot) {
      projects.push({
        name: path.basename(projectRoot),
        paths: dirs,
        projectRoot,
        provider: "claude",
      });
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  },

  async listSessions(projectPaths: string[]): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const seenIds = new Set<string>();

    for (const projectDir of projectPaths) {
      let files: string[];
      try {
        files = await readdir(projectDir);
      } catch {
        continue;
      }

      for (const filename of files) {
        if (!filename.endsWith(".jsonl")) continue;
        if (filename.includes("backup")) continue;

        const filePath = path.join(projectDir, filename);
        try {
          const fileStat = await stat(filePath);
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim());

          let sessionId = filename.replace(".jsonl", "");
          let summary = "";
          let startTime = "";
          let lastUpdated = "";
          let messageCount = 0;
          const previewMessages: string[] = [];

          for (const rawLine of lines) {
            const parsed = JSON.parse(rawLine) as ClaudeLine;

            // Extract session ID from first user message
            if (parsed.sessionId && !seenIds.has(parsed.sessionId)) {
              sessionId = parsed.sessionId;
            }

            // Extract title
            if (parsed.type === "custom-title" && parsed.customTitle) {
              summary = parsed.customTitle;
            }

            // Timestamps
            if (parsed.timestamp) {
              if (!startTime) startTime = parsed.timestamp;
              lastUpdated = parsed.timestamp;
            }

            // Count visible messages
            if (isVisibleMessage(parsed)) {
              messageCount++;
            }

            // Collect previews from user text messages
            if (previewMessages.length < 3) {
              const text = userTextContent(parsed);
              if (text !== null && text.length > 5) {
                previewMessages.push(
                  text.slice(0, 200).replace(/\n/g, " "),
                );
              }
            }
          }

          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);

          // Derive summary from first user message if no custom title
          if (!summary && previewMessages.length > 0) {
            summary = previewMessages[0].slice(0, 80);
          }

          sessions.push({
            sessionId,
            filePath,
            summary,
            startTime,
            lastUpdated,
            messageCount,
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

  // [LAW:dataflow-not-control-flow] Deep link and tree-click both flow through
  // selectSession(project, session); findSession is the URL path's way to produce
  // that same (project, session) pair without materializing every project.
  async findSession(sessionId: string) {
    const filename = `${sessionId}.jsonl`;
    let entries: string[];
    try {
      entries = await readdir(CLAUDE_PROJECTS);
    } catch {
      return null;
    }
    for (const dirName of entries) {
      const projectDir = path.join(CLAUDE_PROJECTS, dirName);
      const filePath = path.join(projectDir, filename);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      const projectRoot = await extractProjectPath(projectDir);
      if (!projectRoot) return null;
      const session = await buildSessionInfoForFile(filePath, fileStat.size);
      const project: Project = {
        name: path.basename(projectRoot),
        paths: [projectDir],
        projectRoot,
        provider: "claude",
      };
      return { project, session };
    }
    return null;
  },

  async loadSession(filePath: string): Promise<MessageSummary[]> {
    const content = await readFile(filePath, "utf-8");
    loadedLines = content.split("\n");
    loadedParsed = [];
    physicalLineMap = [];
    loadedPath = filePath;

    const visible = parseVisibleMessages(content);
    const summaries: MessageSummary[] = [];
    for (let i = 0; i < visible.length; i++) {
      const { parsed, physIdx } = visible[i];
      physicalLineMap.push(physIdx);
      loadedParsed.push(parsed);
      summaries.push(buildSummary(parsed, i, physIdx));
    }
    return summaries;
  },

  summarizeContent(content: string): MessageSummary[] {
    const visible = parseVisibleMessages(content);
    return visible.map((v, i) => buildSummary(v.parsed, i, v.physIdx));
  },

  getMessageContent(index: number): string {
    const parsed = loadedParsed[index];
    if (!parsed) return "";
    return JSON.stringify(parsed, null, 2);
  },

  getMessageRaw(index: number): unknown {
    return loadedParsed[index] ?? null;
  },

  getMessagesContent(indices: number[]): string {
    const sorted = [...indices].sort((a, b) => a - b);
    return sorted
      .map((i) => {
        const parsed = loadedParsed[i];
        if (!parsed) return "";
        return extractFormattedText(parsed);
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  },

  autoTrimSuggestions(): number[] {
    const toRemove = new Set<number>();
    for (let i = 0; i < loadedParsed.length; i++) {
      const parsed = loadedParsed[i];
      const flags = analyzeFlags(parsed, countTokens(extractBillableText(parsed)));
      if (flags.includes("repetitive")) toRemove.add(i);
      if (flags.includes("system-noise")) toRemove.add(i);
    }
    return [...toRemove].sort((a, b) => a - b);
  },

  // [LAW:single-enforcer] Shape what saveSession would write, without I/O.
  // The editor coordinator calls this to run the validator pre-write; any
  // consumer that wants to preflight an edit (proxy, schema:check) can use
  // the same entrypoint.
  previewSaveContent(indicesToRemove: number[]): string {
    return computeSaveContent(indicesToRemove);
  },

  async saveSession(
    indicesToRemove: number[],
    outputPath?: string,
  ): Promise<string> {
    if (!loadedPath) {
      throw new Error("No session loaded");
    }

    const content = computeSaveContent(indicesToRemove);
    const dest = outputPath ?? loadedPath;
    await writeFile(dest, content, "utf-8");

    // Reload
    loadedPath = dest;
    return dest;
  },

  async compressToolResults(
    indices: number[],
    options: CompressToolsOptions,
    handle?: TaskHandle,
  ): Promise<CompressToolsResult> {
    const { summarizeThreshold, truncateThreshold, keepLastN } = options;

    // Protected tail: the last N tool-result messages in the whole session,
    // regardless of which indices the caller passed. The assistant typically
    // references these on the next turn, and truncating would degrade
    // continuation context.
    const toolResultLogicalIndices: number[] = [];
    for (let i = 0; i < loadedParsed.length; i++) {
      const parsed = loadedParsed[i];
      const c = parsed.message?.content;
      if (Array.isArray(c) && c.some((b) => b.type === "tool_result")) {
        toolResultLogicalIndices.push(i);
      }
    }
    const protectedTail = new Set(
      keepLastN > 0 ? toolResultLogicalIndices.slice(-keepLastN) : [],
    );

    const updated: MessageSummary[] = [];
    let truncatedCount = 0;
    let summarizedCount = 0;
    let skippedTooSmall = 0;
    let skippedProtected = 0;

    const total = indices.length;
    handle?.reportProgress(0, total);

    for (let i = 0; i < indices.length; i++) {
      handle?.throwIfCancelled();
      const idx = indices[i];

      if (protectedTail.has(idx)) {
        skippedProtected++;
        handle?.reportProgress(i + 1, total);
        continue;
      }

      const parsed = loadedParsed[idx];
      if (!parsed) {
        handle?.reportProgress(i + 1, total);
        continue;
      }
      const content = parsed.message?.content;
      if (!Array.isArray(content)) {
        handle?.reportProgress(i + 1, total);
        continue;
      }

      let modified = false;
      let didTruncate = false;
      let didSummarize = false;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        const tokens = countTokens(text);

        // Threshold dispatch — the token count decides the strategy.
        // [LAW:dataflow-not-control-flow] Variability lives in the data, not
        // a branch on which button the user clicked.
        if (tokens < truncateThreshold) {
          skippedTooSmall++;
          continue;
        }

        if (tokens >= summarizeThreshold) {
          handle?.reportProgress(
            i,
            total,
            `Summarizing result ${i + 1} of ${total} (${tokens} tokens)`,
          );
          const summary = await chatComplete(
            `You are a tool result summarizer. Condense this tool output to its essential information — the facts, values, and findings that the assistant would need if continuing this conversation. Be terse. Preserve key data verbatim (paths, names, numbers, errors). Output only the summary, no preamble.`,
            text,
            handle?.signal,
          );
          handle?.throwIfCancelled();
          block.content = `[summarized] ${summary}`;
          didSummarize = true;
        } else {
          handle?.reportProgress(
            i,
            total,
            `Truncating result ${i + 1} of ${total} (${tokens} tokens)`,
          );
          block.content = truncateMiddle(text);
          didTruncate = true;
        }
        modified = true;
      }

      if (modified) {
        const physIdx = physicalLineMap[idx];
        loadedLines[physIdx] = JSON.stringify(parsed);
        updated.push(buildSummary(parsed, idx, physIdx));
        if (didSummarize) summarizedCount++;
        else if (didTruncate) truncatedCount++;
      }

      handle?.reportProgress(i + 1, total);
    }

    return {
      updated,
      truncatedCount,
      summarizedCount,
      skippedTooSmall,
      skippedProtected,
    };
  },

  diffContent(oldContent: string, newContent: string): DiffEntry[] {
    const oldVisible = parseVisibleMessages(oldContent);
    const newVisible = parseVisibleMessages(newContent);

    // Build UUID maps for fast lookup. Lines without UUIDs fall back to position-based id.
    const oldByKey = new Map<string, { parsed: ClaudeLine; physIdx: number; pos: number }>();
    const newByKey = new Map<string, { parsed: ClaudeLine; physIdx: number; pos: number }>();
    const keyOf = (parsed: ClaudeLine, pos: number): string =>
      parsed.uuid ?? `pos:${pos}`;

    oldVisible.forEach((v, pos) =>
      oldByKey.set(keyOf(v.parsed, pos), { ...v, pos }),
    );
    newVisible.forEach((v, pos) =>
      newByKey.set(keyOf(v.parsed, pos), { ...v, pos }),
    );

    // Walk new in order; for each, classify against old.
    // Track which old keys we've consumed so we can identify removed at the end.
    const entries: DiffEntry[] = [];
    let unchangedRun = 0;

    const flushUnchanged = () => {
      if (unchangedRun > 0) {
        entries.push({ kind: "unchanged", count: unchangedRun });
        unchangedRun = 0;
      }
    };

    const seenOldKeys = new Set<string>();

    // First pass: walk old to detect removed-only-or-modified, walk new to detect added.
    // To keep the diff readable in order, we walk new and emit unchanged/modified/added,
    // then append removed entries at the end (anything in old but not in new).
    for (let i = 0; i < newVisible.length; i++) {
      const newItem = newVisible[i];
      const key = keyOf(newItem.parsed, i);
      const oldItem = oldByKey.get(key);

      if (!oldItem) {
        flushUnchanged();
        entries.push({
          kind: "added",
          messages: [buildSummary(newItem.parsed, i, newItem.physIdx)],
        });
        continue;
      }

      seenOldKeys.add(key);

      // Compare normalized JSON to detect modification
      const oldStr = JSON.stringify(oldItem.parsed);
      const newStr = JSON.stringify(newItem.parsed);
      if (oldStr === newStr) {
        unchangedRun++;
      } else {
        flushUnchanged();
        entries.push({
          kind: "modified",
          before: buildSummary(oldItem.parsed, oldItem.pos, oldItem.physIdx),
          after: buildSummary(newItem.parsed, i, newItem.physIdx),
        });
      }
    }
    flushUnchanged();

    // Append removed entries (those in old but not in new), preserving old order
    const removed: MessageSummary[] = [];
    oldVisible.forEach((v, pos) => {
      const key = keyOf(v.parsed, pos);
      if (!seenOldKeys.has(key)) {
        removed.push(buildSummary(v.parsed, pos, v.physIdx));
      }
    });
    if (removed.length > 0) {
      entries.push({ kind: "removed", messages: removed });
    }

    return entries;
  },
};
