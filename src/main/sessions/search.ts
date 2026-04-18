// [LAW:single-enforcer] All full-text session search goes through searchSessions.
// Shells out to the bundled @vscode/ripgrep binary. The child process is owned here,
// tied 1:1 to the TaskHandle — cancellation flows through handle.signal, nothing else.
// [LAW:one-source-of-truth] Session metadata comes from the provider adapter's
// listSessions(); this module embeds a subset into each result but never redefines it.
// [LAW:dataflow-not-control-flow] The result is a flat SessionSearchResult[]; the
// renderer renders whichever shape it receives. No "isSearching" branches in the UI.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  ProviderKind,
  SessionInfo,
  SessionSearchMatch,
  SessionSearchResult,
} from "../../shared/types";
import type { TaskHandle } from "../tasks/runner";
import { TaskCancelledError } from "../tasks/runner";
import { getAllProviders, getProvider } from "./registry";

// Resolve the ripgrep binary ourselves rather than importing rgPath from
// @vscode/ripgrep. That package computes its path from `__dirname` at import
// time, which Vite evaluates while bundling — resulting in a path baked into
// the bundle output dir (e.g. ".vite/bin/rg") that doesn't exist at runtime.
// Resolving on-demand from known filesystem locations sidesteps the issue for
// both dev (node_modules under app path) and packaged builds (asar.unpacked).
// [LAW:single-enforcer] One resolver. Memoized after first successful probe.
let cachedRgPath: string | null = null;
function getRgPath(): string {
  if (cachedRgPath) return cachedRgPath;
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const appPath = app?.getAppPath?.() ?? process.cwd();
  const candidates = [
    path.join(appPath, "node_modules", "@vscode", "ripgrep", "bin", binary),
    path.join(process.cwd(), "node_modules", "@vscode", "ripgrep", "bin", binary),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "@vscode",
          "ripgrep",
          "bin",
          binary,
        )
      : "",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedRgPath = p;
      return p;
    }
  }
  throw new Error(
    `ripgrep binary not found. Checked:\n  ${candidates.join("\n  ")}`,
  );
}

// Caps protect IPC payload size; a session with 10k matches shouldn't blow up the
// renderer. At 25 the user can still see "matchesTruncated" and expand if they care.
const MAX_MATCHES_PER_SESSION = 25;
const MIN_QUERY_LENGTH = 2;
const SNIPPET_WINDOW = 200; // total chars in the windowed snippet around a match
const PROGRESS_STRIDE = 20; // emit a progress event every N new matches

// rg --json emits one JSON object per line. We care about "match" events only.
interface RgSubmatch {
  match: { text: string } | { bytes: string };
  start: number;
  end: number;
}
interface RgMatchEvent {
  type: "match";
  data: {
    path: { text: string } | { bytes: string };
    lines: { text: string } | { bytes: string };
    line_number: number;
    absolute_offset: number;
    submatches: RgSubmatch[];
  };
}

// Aggregated per-file state during streaming. Converted to SessionSearchResult[] at the end.
interface FileAccumulator {
  provider: ProviderKind;
  projectName: string;
  projectRoot: string;
  totalMatches: number;
  matches: SessionSearchMatch[]; // capped at MAX_MATCHES_PER_SESSION
}

// Batch size and concurrency are the two streaming-performance knobs.
// Batch size trades renderer re-render cost against latency-to-first-paint.
// Concurrency trades wall-clock time against filesystem contention.
const ENRICH_CONCURRENCY = 8;
const BATCH_SIZE = 10;

export async function searchSessions(
  query: string,
  handle?: TaskHandle,
  onBatch?: (batch: SessionSearchResult[]) => void,
): Promise<SessionSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    throw new Error(`Query too short (minimum ${MIN_QUERY_LENGTH} characters)`);
  }

  // Build storage-dir -> {provider, project} lookup so rg match paths resolve in O(1).
  // Going through the registry directly (not editor.ts) avoids a circular import,
  // since editor.ts re-exports this module for the IPC layer.
  const projects = (
    await Promise.all(getAllProviders().map((a) => a.listProjects()))
  ).flat();
  const dirToProject = new Map<
    string,
    { provider: ProviderKind; projectName: string; projectRoot: string }
  >();
  const roots: string[] = [];
  for (const p of projects) {
    for (const dir of p.paths) {
      dirToProject.set(dir, {
        provider: p.provider,
        projectName: p.name,
        projectRoot: p.projectRoot,
      });
      roots.push(dir);
    }
  }

  if (roots.length === 0) return [];

  const files = new Map<string, FileAccumulator>();
  let totalMatchCount = 0;

  await streamRipgrep(trimmed, roots, handle?.signal, (event) => {
    const filePath = "text" in event.data.path ? event.data.path.text : null;
    if (!filePath) return; // binary / non-utf8 path — skip
    const lineText = "text" in event.data.lines ? event.data.lines.text : null;
    if (!lineText) return; // binary line — skip

    const acc =
      files.get(filePath) ?? createAccumulator(filePath, dirToProject);
    if (!acc) return; // path didn't land in any known project dir
    files.set(filePath, acc);

    acc.totalMatches += 1;
    totalMatchCount += 1;

    if (acc.matches.length < MAX_MATCHES_PER_SESSION) {
      const submatch = event.data.submatches[0];
      if (submatch && "text" in submatch.match) {
        const textSubmatch = submatch as RgSubmatch & {
          match: { text: string };
        };
        acc.matches.push(
          buildMatch(event.data.line_number, lineText, textSubmatch),
        );
      }
    }

    if (totalMatchCount % PROGRESS_STRIDE === 0) {
      handle?.reportProgress(
        totalMatchCount,
        0,
        `${totalMatchCount} matches in ${files.size} sessions`,
      );
    }
  });

  // Final progress snapshot so the toast reflects the real count, not the last stride.
  handle?.reportProgress(
    totalMatchCount,
    0,
    `${totalMatchCount} matches in ${files.size} sessions`,
  );

  return enrichAndSort(files, onBatch);
}

function createAccumulator(
  filePath: string,
  dirToProject: Map<
    string,
    { provider: ProviderKind; projectName: string; projectRoot: string }
  >,
): FileAccumulator | null {
  // Walk upward from the file's directory until we hit a registered storage dir.
  // This handles providers (like Claude) that put sessions in subdirs, and is O(depth).
  let dir = path.dirname(filePath);
  for (let i = 0; i < 6; i++) {
    const meta = dirToProject.get(dir);
    if (meta) {
      return {
        provider: meta.provider,
        projectName: meta.projectName,
        projectRoot: meta.projectRoot,
        totalMatches: 0,
        matches: [],
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildMatch(
  lineNumber: number,
  lineText: string,
  submatch: RgSubmatch & { match: { text: string } },
): SessionSearchMatch {
  // rg's start/end are BYTE offsets; when the file is UTF-8 and all characters
  // in the match context are ASCII this equals char offsets. For multi-byte
  // characters we'd drift — acceptable for a highlight (no correctness risk,
  // just visual shift by a few chars) and our tests exercise the ASCII path.
  const line = lineText.replace(/\n$/, "");
  const matchLen = submatch.end - submatch.start;
  const margin = Math.max(0, Math.floor((SNIPPET_WINDOW - matchLen) / 2));
  const windowStart = Math.max(0, submatch.start - margin);
  const windowEnd = Math.min(line.length, windowStart + SNIPPET_WINDOW);

  let snippet = line.slice(windowStart, windowEnd);
  let matchStart = submatch.start - windowStart;
  let matchEnd = submatch.end - windowStart;

  // Collapse whitespace + JSON escape artifacts for readability. We do this AFTER
  // computing offsets, so each char swap must preserve index positions (same length).
  snippet = snippet.replace(/\\n/g, "  ").replace(/\t/g, " ");

  // Clamp offsets in case the submatch extended past our window (long matches).
  matchStart = Math.max(0, Math.min(matchStart, snippet.length));
  matchEnd = Math.max(matchStart, Math.min(matchEnd, snippet.length));

  return {
    lineNumber,
    messageRole: "", // filled in during enrichAndSort
    snippet,
    matchStart,
    matchEnd,
  };
}

// Spawns rg with --json, line-parses stdout, calls onMatch for every match event.
// Cancellation: child is spawned with { signal } so abort kills it; we also listen
// explicitly as belt-and-suspenders for environments that strip the option.
function streamRipgrep(
  query: string,
  roots: string[],
  signal: AbortSignal | undefined,
  onMatch: (event: RgMatchEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Glob filters mirror the provider adapters' `listSessions` definition of
    // "a session file" — without them rg would happily search subagent
    // transcripts, backup files, and any other JSONL artifacts in the project
    // tree, inflating counts and then silently dropping non-resolvable hits at
    // enrichment. [LAW:one-source-of-truth] Keep this list in lockstep with
    // each adapter's own `listSessions` filter logic.
    const args = [
      "--json",
      "--ignore-case",
      "--no-messages",
      "--fixed-strings",
      "--glob",
      "*.jsonl",
      "--glob",
      "*.json",
      "--glob",
      "!*backup*",
      "--glob",
      "!**/subagents/**",
      "--",
      query,
      ...roots,
    ];

    const child = spawn(getRgPath(), args, signal ? { signal } : {});

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    if (signal) {
      if (signal.aborted) {
        child.kill();
        reject(new TaskCancelledError(""));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            const evt = JSON.parse(line) as { type: string };
            if (evt.type === "match") onMatch(evt as RgMatchEvent);
          } catch {
            // Skip malformed lines — rg shouldn't produce any but we don't want to
            // crash the whole search over a single weird line.
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    });

    // stderr is swallowed by --no-messages for missing-path warnings, but real
    // errors (bad regex, etc.) still land here. Capture for the reject message.
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new TaskCancelledError(""));
        return;
      }
      // rg exit codes: 0 = matches, 1 = no matches, 2+ = error.
      // Both 0 and 1 are success for us — no matches is a valid outcome.
      if (code === 0 || code === 1 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

// Parallel enrichment with streaming batch emission. For each accumulated file
// we call listSessions (cached per-dir) and readFile (for role attachment);
// completing that in a worker pool of ENRICH_CONCURRENCY keeps filesystem
// contention reasonable while pipelining N files' IO instead of serializing it.
// [LAW:dataflow-not-control-flow] onBatch is always called with any non-empty
// trailing batch at the end — no "if any results, flush" branch at callsites.
async function enrichAndSort(
  files: Map<string, FileAccumulator>,
  onBatch?: (batch: SessionSearchResult[]) => void,
): Promise<SessionSearchResult[]> {
  const results: SessionSearchResult[] = [];
  let pending: SessionSearchResult[] = [];
  // Per-dir listSessions cache keyed by storage dir. Race between concurrent
  // workers is benign — worst case they duplicate a listSessions call once.
  const sessionInfoCache = new Map<string, Map<string, SessionInfo>>();

  const entries = [...files.entries()];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= entries.length) return;
      const [filePath, acc] = entries[i];
      const result = await enrichOne(filePath, acc, sessionInfoCache);
      if (!result) continue;

      results.push(result);
      pending.push(result);
      if (pending.length >= BATCH_SIZE) {
        onBatch?.(pending);
        pending = [];
      }
    }
  }

  await Promise.all(
    Array.from({ length: ENRICH_CONCURRENCY }, () => worker()),
  );

  if (pending.length > 0) {
    onBatch?.(pending);
    pending = [];
  }

  // Recency-first: the user's mental model for finding a session is "what was
  // I doing recently?", not "what matched the most?". totalMatches as a sort
  // key would bury recent sessions behind older, chattier ones.
  results.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );
  return results;
}

async function enrichOne(
  filePath: string,
  acc: FileAccumulator,
  sessionInfoCache: Map<string, Map<string, SessionInfo>>,
): Promise<SessionSearchResult | null> {
  const sessionInfo = await resolveSessionInfo(
    filePath,
    acc.provider,
    sessionInfoCache,
  );
  if (!sessionInfo) return null; // file disappeared or adapter doesn't know it

  const fileContent = await readFile(filePath, "utf-8").catch(() => "");
  if (fileContent) {
    attachRoles(acc.provider, fileContent, acc.matches);
  }

  return {
    provider: acc.provider,
    projectName: acc.projectName,
    projectRoot: acc.projectRoot,
    sessionId: sessionInfo.sessionId,
    filePath,
    summary: sessionInfo.summary,
    lastUpdated: sessionInfo.lastUpdated,
    messageCount: sessionInfo.messageCount,
    fileSizeBytes: sessionInfo.fileSizeBytes,
    totalMatches: acc.totalMatches,
    matches: acc.matches,
    matchesTruncated: acc.totalMatches > acc.matches.length,
  };
}

async function resolveSessionInfo(
  filePath: string,
  provider: ProviderKind,
  cache: Map<string, Map<string, SessionInfo>>,
): Promise<SessionInfo | null> {
  // Claude sessions: <storage-dir>/<sessionId>.jsonl
  // Gemini sessions: <storage-dir>/chats/<sessionId>.json  (chats is one level down)
  const adapter = getProvider(provider);

  // Try the immediate parent dir, then one level up (for Gemini's chats/ layout).
  const candidates = [
    path.dirname(filePath),
    path.dirname(path.dirname(filePath)),
  ];
  for (const dir of candidates) {
    let dirCache = cache.get(dir);
    if (!dirCache) {
      const sessions = await adapter
        .listSessions([dir])
        .catch(() => [] as SessionInfo[]);
      if (sessions.length === 0) continue;
      dirCache = new Map(sessions.map((s) => [s.filePath, s]));
      cache.set(dir, dirCache);
    }
    const hit = dirCache.get(filePath);
    if (hit) return hit;
  }
  return null;
}

function attachRoles(
  provider: ProviderKind,
  fileContent: string,
  matches: SessionSearchMatch[],
): void {
  const lines = fileContent.split("\n");

  if (provider === "claude") {
    // JSONL: each line IS a message. Parse the matched line directly.
    for (const m of matches) {
      const raw = lines[m.lineNumber - 1];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as {
          type?: string;
          message?: { role?: string };
        };
        m.messageRole = classifyClaudeRole(parsed);
      } catch {
        // malformed — leave role empty
      }
    }
    return;
  }

  if (provider === "gemini") {
    // JSON array — scan backward from each match line for the nearest `"type":` field.
    // Not guaranteed correct (could belong to a nested object), but good enough
    // for a UI label. The match itself is still surfaced with its snippet.
    for (const m of matches) {
      const role = findNearestGeminiType(lines, m.lineNumber - 1);
      if (role) m.messageRole = role;
    }
    return;
  }
}

function classifyClaudeRole(parsed: {
  type?: string;
  message?: { role?: string };
}): string {
  if (parsed.type === "assistant") return "assistant";
  if (parsed.type === "system") return "system";
  if (parsed.type === "user") {
    // User type covers both text messages and tool results. We don't re-classify
    // here (that would duplicate adapter logic); the UI can map "user" generically.
    return "user";
  }
  return parsed.type ?? "";
}

function findNearestGeminiType(lines: string[], fromIdx: number): string {
  for (let i = fromIdx; i >= 0 && i > fromIdx - 200; i--) {
    const l = lines[i];
    const m = /"type"\s*:\s*"([^"]+)"/.exec(l);
    if (m) return m[1];
  }
  return "";
}
