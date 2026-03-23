// [LAW:one-source-of-truth] Gemini session discovery. Scans ~/.gemini/tmp/ for projects and sessions.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GeminiProject, GeminiSessionInfo } from "../../shared/types";

const GEMINI_TMP = path.join(process.env.HOME ?? "", ".gemini", "tmp");

export async function listProjects(): Promise<GeminiProject[]> {
  let entries;
  try {
    entries = await readdir(GEMINI_TMP, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: GeminiProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(GEMINI_TMP, entry.name);
    const rootFile = path.join(projectDir, ".project_root");
    let projectRoot = "";
    try {
      projectRoot = (await readFile(rootFile, "utf-8")).trim();
    } catch {
      projectRoot = entry.name;
    }

    // Use the last path component as the display name, full path as subtitle
    const displayName = projectRoot.startsWith("/")
      ? path.basename(projectRoot)
      : entry.name;

    projects.push({
      name: displayName,
      path: projectDir,
      projectRoot,
    });
  }

  // Sort by display name
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return projects;
}

export async function listSessions(
  projectPath: string,
): Promise<GeminiSessionInfo[]> {
  const chatsDir = path.join(projectPath, "chats");
  let entries: string[];
  try {
    entries = await readdir(chatsDir);
  } catch {
    return [];
  }

  const sessions: GeminiSessionInfo[] = [];

  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const filePath = path.join(chatsDir, filename);
    const fileStat = await stat(filePath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);

    // Extract first few user message previews for context
    const previewMessages: string[] = [];
    const msgs = data.messages ?? [];
    for (const msg of msgs) {
      if (previewMessages.length >= 3) break;
      if (msg.type !== "user") continue;
      const contents = msg.content ?? [];
      for (const c of contents) {
        if (c.text && typeof c.text === "string" && c.text.length > 5) {
          previewMessages.push(c.text.slice(0, 200).replace(/\n/g, " "));
          break;
        }
      }
    }

    sessions.push({
      sessionId: data.sessionId ?? filename,
      filePath,
      summary: data.summary ?? "",
      startTime: data.startTime ?? "",
      lastUpdated: data.lastUpdated ?? "",
      messageCount: msgs.length,
      fileSizeBytes: fileStat.size,
      previewMessages,
    });
  }

  // Most recent first
  sessions.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );

  return sessions;
}
