import { useEffect, useState, useRef } from "react";
import CodeEditor from "@uiw/react-textarea-code-editor";
import { usePromptStore } from "../store/prompt";
import type { Prompt, PromptId } from "../../shared/types";
import { ResizableSplit } from "./ResizableSplit";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function PromptLibrary() {
  const { prompts, selectedId, select, load, save, remove } = usePromptStore();
  const selected = prompts.find((p) => p.id === selectedId) ?? null;

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    load();
  }, [load]);

  // Sync editor state when selection changes
  useEffect(() => {
    setTitle(selected?.title ?? "");
    setContent(selected?.content ?? "");
    setDirty(false);
  }, [selected]);

  function handleSelect(id: PromptId) {
    select(id);
  }

  async function handleSave() {
    const now = Date.now();
    const prompt: Prompt = selected
      ? { ...selected, title, content, updatedAt: now }
      : {
          id: crypto.randomUUID() as PromptId,
          filename: `${slugify(title) || "untitled"}.md`,
          title,
          content,
          createdAt: now,
          updatedAt: now,
        };
    await save(prompt);
    select(prompt.id);
    setDirty(false);
  }

  async function handleDelete() {
    if (!selected) return;
    await remove(selected.filename);
  }

  function handleNew() {
    select(null);
    setTitle("");
    setContent("");
    setDirty(false);
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1500);
  }

  async function handlePasteAsNew() {
    const text = await navigator.clipboard.readText();
    select(null);
    setTitle("");
    setContent(text);
    setDirty(true);
  }

  return (
    <ResizableSplit
      orientation="horizontal"
      side="before"
      defaultSize={224}
      minSize={160}
      maxSize={500}
      className="h-full"
      testId="prompt-library-split"
    >
      {/* Sidebar list */}
      <div className="flex h-full flex-col gap-2 pr-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-300">
            Prompts ({prompts.length})
          </h3>
          <div className="flex gap-1">
            <button
              onClick={handlePasteAsNew}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Paste clipboard as new prompt"
            >
              Paste New
            </button>
            <button
              onClick={handleNew}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Create new prompt"
            >
              + New
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto">
          {prompts.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className={`w-full truncate rounded px-3 py-2 text-left text-sm transition-colors ${
                p.id === selectedId
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
              }`}
            >
              {p.title}
            </button>
          ))}
          {prompts.length === 0 && (
            <p className="px-3 py-2 text-xs text-neutral-500">
              No prompts yet. Create one or paste from clipboard.
            </p>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex h-full flex-col gap-3 pl-3">
        {/* Title */}
        <input
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          placeholder="Prompt title..."
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />

        {/* Code editor */}
        <div className="flex-1 overflow-auto rounded-md border border-neutral-700">
          <CodeEditor
            ref={editorRef}
            value={content}
            language="markdown"
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            padding={12}
            data-color-mode="dark"
            minHeight={200}
            style={{
              backgroundColor: "rgb(23 23 23)", // neutral-900
              fontFamily:
                "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
              fontSize: 13,
              lineHeight: 1.6,
              minHeight: "100%",
            }}
            placeholder="Write your prompt here..."
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            className="rounded-md bg-neutral-700 px-4 py-1.5 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-600 disabled:opacity-40 disabled:hover:bg-neutral-700"
          >
            {selected ? "Save" : "Create"}
            {dirty && " *"}
          </button>
          <button
            onClick={handleCopy}
            className="rounded-md border border-neutral-700 px-4 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800"
          >
            {copyFeedback ? "Copied!" : "Copy"}
          </button>
          {selected && (
            <button
              onClick={handleDelete}
              className="rounded-md border border-neutral-700 px-4 py-1.5 text-sm text-red-400 transition-colors hover:border-red-700 hover:bg-red-950"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </ResizableSplit>
  );
}
