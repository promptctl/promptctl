// [LAW:one-source-of-truth] Gemini session discovery.
// Project names come from ~/.gemini/projects.json (path → name mapping).
// Session files live under ~/.gemini/tmp/<folder>/chats/*.json.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GeminiProject, GeminiSessionInfo } from "../../shared/types";

const GEMINI_HOME = path.join(process.env.HOME ?? "", ".gemini");
const GEMINI_TMP = path.join(GEMINI_HOME, "tmp");

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

export async function listProjects(): Promise<GeminiProject[]> {
  const [entries, folderToRoot] = await Promise.all([
    readdir(GEMINI_TMP, { withFileTypes: true }).catch(() => []),
    loadProjectNames(),
  ]);

  // Collect all valid dirs, then merge by display name
  const byName = new Map<
    string,
    { projectRoot: string; dirs: string[] }
  >();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(GEMINI_TMP, entry.name);

    // Resolve project root: try .project_root file, then projects.json mapping
    let projectRoot = "";
    try {
      projectRoot = (
        await readFile(path.join(projectDir, ".project_root"), "utf-8")
      ).trim();
    } catch {
      projectRoot = folderToRoot.get(entry.name) ?? "";
    }

    // No project name → skip entirely
    const displayName = projectRoot.startsWith("/")
      ? path.basename(projectRoot)
      : "";
    if (!displayName) continue;

    // Verify the project has session files worth showing
    const chatsDir = path.join(projectDir, "chats");
    let hasSessions = false;
    try {
      const chatFiles = await readdir(chatsDir);
      hasSessions = chatFiles.some((f) => f.endsWith(".json"));
    } catch {
      // no chats dir
    }
    if (!hasSessions) continue;

    // Merge dirs that share the same display name
    const existing = byName.get(displayName);
    if (existing) {
      existing.dirs.push(projectDir);
    } else {
      byName.set(displayName, { projectRoot, dirs: [projectDir] });
    }
  }

  const projects: GeminiProject[] = [];
  for (const [name, { projectRoot, dirs }] of byName) {
    projects.push({ name, paths: dirs, projectRoot, provider: "gemini" });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

export async function listSessions(
  projectPaths: string[],
): Promise<GeminiSessionInfo[]> {
  const sessions: GeminiSessionInfo[] = [];
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
      // Skip backup files
      if (filename.includes("backup")) continue;

      const filePath = path.join(chatsDir, filename);
      try {
        const fileStat = await stat(filePath);
        const raw = await readFile(filePath, "utf-8");
        const data = JSON.parse(raw);

        const sessionId = data.sessionId ?? filename;
        if (seenIds.has(sessionId)) continue;
        seenIds.add(sessionId);

        // Extract first few user message previews for context
        const previewMessages: string[] = [];
        const msgs = data.messages ?? [];
        for (const msg of msgs) {
          if (previewMessages.length >= 3) break;
          if (msg.type !== "user") continue;
          const content = msg.content;
          // content can be a string or an array of content objects
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

  // Most recent first
  sessions.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );

  return sessions;
}
