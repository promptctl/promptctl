// [LAW:single-enforcer] All Anthropic content-block rendering goes through
// renderBlock — Request, Diff, and Response tabs all dispatch here.
// [LAW:one-type-per-behavior] One renderer per block type; unknown types
// fall through to OpaqueBlock (a JsonlLineView), they are not skipped.
// [LAW:dataflow-not-control-flow] Control flow is identical for every block:
// look up by type, render. Variability lives in the registry map.
//
// highlightSubstring on BlockCtx is the search seam: when set, text-bearing
// renderers wrap matching substrings with <mark>. The JsonlLineView-based
// renderers (tool_use input, OpaqueBlock) don't mark inside the structured
// view — the row-level match cue is sufficient and threading marks into
// the JSON viewer is a separate, larger surface.

import type { ReactNode } from "react";
import { JsonlLineView } from "../jsonl-view/JsonlLineView";
import { splitHighlights } from "./search";

export interface BlockCtx {
  index: number;
  highlightSubstring?: string;
}

export type BlockRenderer = (block: unknown, ctx: BlockCtx) => ReactNode;

const REGISTRY: Record<string, BlockRenderer> = {
  text: TextBlock,
  tool_use: ToolUseBlock,
  tool_result: ToolResultBlock,
  thinking: ThinkingBlock,
};

export function renderBlock(block: unknown, ctx: BlockCtx): ReactNode {
  const type = blockType(block);
  const renderer = REGISTRY[type] ?? OpaqueBlock;
  return renderer(block, ctx);
}

export function blockKey(block: unknown, index: number): string {
  const rec = asRecord(block);
  if (rec && typeof rec.id === "string") return rec.id;
  if (rec && typeof rec.tool_use_id === "string") {
    return `tool_result-${rec.tool_use_id}`;
  }
  return `block-${blockType(block)}-${index}`;
}

function TextBlock(block: unknown, ctx: BlockCtx): ReactNode {
  const rec = asRecord(block);
  const text = typeof rec?.text === "string" ? rec.text : "";
  return (
    <BlockShell label="text" testId="block-text">
      <pre className="whitespace-pre-wrap p-3 text-sm text-neutral-200">
        <HighlightedText text={text} query={ctx.highlightSubstring ?? ""} />
      </pre>
    </BlockShell>
  );
}

function ToolUseBlock(block: unknown): ReactNode {
  const rec = asRecord(block);
  const name = typeof rec?.name === "string" ? rec.name : "(unnamed)";
  const id = typeof rec?.id === "string" ? rec.id : "";
  const input = rec?.input ?? null;
  return (
    <BlockShell
      label={
        <span>
          <span className="rounded bg-cyan-950 px-2 py-0.5 font-mono text-xs text-cyan-300">
            tool_use
          </span>
          <span className="ml-2 font-mono text-neutral-200">{name}</span>
          {id ? (
            <span className="ml-2 text-xs text-neutral-500">
              {id.slice(0, 8)}
            </span>
          ) : null}
        </span>
      }
      testId="block-tool-use"
    >
      <JsonlLineView raw={input} />
    </BlockShell>
  );
}

function ToolResultBlock(block: unknown, ctx: BlockCtx): ReactNode {
  const rec = asRecord(block);
  const toolUseId = typeof rec?.tool_use_id === "string" ? rec.tool_use_id : "";
  const isError = rec?.is_error === true;
  const content = rec?.content;
  return (
    <BlockShell
      label={
        <span>
          <span
            className={
              isError
                ? "rounded bg-red-950 px-2 py-0.5 font-mono text-xs text-red-300"
                : "rounded bg-emerald-950 px-2 py-0.5 font-mono text-xs text-emerald-300"
            }
          >
            tool_result{isError ? " · error" : ""}
          </span>
          {toolUseId ? (
            <span className="ml-2 text-xs text-neutral-500">
              for {toolUseId.slice(0, 8)}
            </span>
          ) : null}
        </span>
      }
      testId="block-tool-result"
      tone={isError ? "error" : "default"}
    >
      {typeof content === "string" ? (
        <pre className="whitespace-pre-wrap p-3 text-sm text-neutral-200">
          <HighlightedText
            text={content}
            query={ctx.highlightSubstring ?? ""}
          />
        </pre>
      ) : (
        <JsonlLineView raw={content ?? null} />
      )}
    </BlockShell>
  );
}

function ThinkingBlock(block: unknown, ctx: BlockCtx): ReactNode {
  const rec = asRecord(block);
  const thinking = typeof rec?.thinking === "string" ? rec.thinking : "";
  return (
    <details
      className="rounded border border-violet-900 bg-violet-950/20"
      data-testid="block-thinking"
    >
      <summary
        className="cursor-pointer px-3 py-2 text-xs text-violet-300"
        // Token-counting for thinking blocks is known-buggy on re-send;
        // see project memory `thinking-blocks-token-bug`.
        title="thinking blocks may show inflated token counts on re-send"
      >
        thinking · {thinking.length} chars
      </summary>
      <pre className="whitespace-pre-wrap border-t border-violet-900 p-3 text-sm text-violet-100">
        <HighlightedText
          text={thinking}
          query={ctx.highlightSubstring ?? ""}
        />
      </pre>
    </details>
  );
}

function OpaqueBlock(block: unknown, ctx: BlockCtx): ReactNode {
  const type = blockType(block);
  return (
    <BlockShell label={`${type} #${ctx.index}`} testId="block-opaque">
      <JsonlLineView raw={block} />
    </BlockShell>
  );
}

// [LAW:single-enforcer] Substring marking lives here so every text-bearing
// block renderer wraps matches the same way — no per-block divergence in
// the marker shape. Empty query yields the unmarked text as a single
// node; the consumer doesn't need to branch.
export function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  const segments = splitHighlights(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.isMatch ? (
          <mark
            key={index}
            data-testid="search-highlight"
            className="rounded bg-yellow-700/60 text-yellow-100"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function BlockShell({
  label,
  testId,
  tone = "default",
  children,
}: {
  label: ReactNode;
  testId: string;
  tone?: "default" | "error";
  children: ReactNode;
}) {
  const border = tone === "error" ? "border-red-900" : "border-neutral-800";
  return (
    <section
      className={`rounded border ${border} bg-neutral-950`}
      data-testid={testId}
    >
      <h3 className="border-b border-neutral-900 px-3 py-2 text-xs font-medium text-neutral-400">
        {label}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function blockType(block: unknown): string {
  const rec = asRecord(block);
  return typeof rec?.type === "string" ? rec.type : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
