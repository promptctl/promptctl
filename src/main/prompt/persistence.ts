// [LAW:single-enforcer] All prompt file I/O goes through here.
import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { app } from "electron";
import type { Prompt, PromptId } from "../../shared/types";

// [LAW:one-source-of-truth] Prompts dir lives in the repo root, checked into git.
function promptsDir(): string {
  return join(app.getAppPath(), "prompts");
}

// Frontmatter format:
// ---
// id: <uuid>
// title: <title>
// createdAt: <epoch>
// updatedAt: <epoch>
// ---
// <content>

function parsePromptFile(filename: string, raw: string): Prompt {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta: Record<string, string> = {};
  const content = fmMatch ? fmMatch[2] : raw;

  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  return {
    id: (meta.id || crypto.randomUUID()) as PromptId,
    filename,
    title: meta.title || filename.replace(/\.md$/, ""),
    content,
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
  };
}

function serializePrompt(prompt: Prompt): string {
  const fm = [
    "---",
    `id: ${prompt.id}`,
    `title: ${prompt.title}`,
    `createdAt: ${prompt.createdAt}`,
    `updatedAt: ${prompt.updatedAt}`,
    "---",
  ].join("\n");
  return `${fm}\n${prompt.content}`;
}

export async function loadPrompts(): Promise<Prompt[]> {
  const dir = promptsDir();
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  const prompts: Prompt[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(join(dir, file), "utf-8");
    prompts.push(parsePromptFile(file, raw));
  }

  return prompts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePrompt(prompt: Prompt): Promise<void> {
  const dir = promptsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, prompt.filename), serializePrompt(prompt));
}

export async function deletePrompt(filename: string): Promise<void> {
  await unlink(join(promptsDir(), basename(filename)));
}
