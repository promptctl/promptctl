// Field-renderer registry + generic dispatcher. Drives every value
// rendered in the expanded view. No raw JSON is ever emitted — unknown
// keys fall through to the tree dispatcher, which recurses back into
// FieldGroup for objects and ArrayGroup for arrays.
//
// [LAW:one-source-of-truth] Each field semantic has exactly one renderer.
// [LAW:dataflow-not-control-flow] One render path at every depth: the
// recursive tree. Inline-compact renderers are opt-in via the registry.

import { useState, type ReactNode } from "react";
import {
  Dim,
  FlagGlyph,
  IdValue,
  PathValue,
  Pill,
  PrimitiveValue,
  Signature,
  ThinkingPreview,
  TimeValue,
  TokensValue,
  ToolInput,
  ToolName,
} from "./Primitives";
import { XMLText } from "./XMLText";
import { shortModel } from "./utils";

type FieldRenderer = (value: unknown) => ReactNode;

// ---- Inline renderers (key → compact view, never expandable) -------------
// A renderer only lives here if its output fits on one line. Complex
// fields (message, content, toolUseResult) go through the generic tree
// dispatcher — that keeps deeply nested views legible.
const FIELD_RENDERERS: Record<string, FieldRenderer> = {
  // Opaque identifiers
  uuid: (v) => <IdValue value={String(v ?? "")} len={10} />,
  parentUuid: (v) => <IdValue value={String(v ?? "")} len={10} />,
  sessionId: (v) => <IdValue value={String(v ?? "")} len={10} />,
  messageId: (v) => <IdValue value={String(v ?? "")} len={10} />,
  requestId: (v) => <IdValue value={String(v ?? "")} len={14} />,
  promptId: (v) => <IdValue value={String(v ?? "")} len={10} />,
  toolUseID: (v) => <IdValue value={String(v ?? "")} len={10} />,
  parentToolUseID: (v) => <IdValue value={String(v ?? "")} len={10} />,
  sourceToolAssistantUUID: (v) => <IdValue value={String(v ?? "")} len={10} />,
  tool_use_id: (v) => <IdValue value={String(v ?? "")} len={10} />,
  id: (v) => <IdValue value={String(v ?? "")} len={12} />,

  // Time / path
  timestamp: (v) => <TimeValue value={String(v ?? "")} />,
  cwd: (v) => <PathValue value={String(v ?? "")} />,
  filePath: (v) => <PathValue value={String(v ?? "")} />,

  // Pills
  gitBranch: (v) => <Pill label={String(v)} kind="branch" />,
  version: (v) => <Pill label={String(v)} kind="branch" />,
  userType: (v) => <Pill label={String(v)} kind="system" />,
  entrypoint: (v) => <Pill label={String(v)} kind="system" />,
  slug: (v) => <Pill label={String(v)} kind="model" />,
  permissionMode: (v) => <Pill label={String(v)} kind="usermeta" />,
  model: (v) => <Pill label={shortModel(String(v))} kind="model" />,
  role: (v) => <Pill label={String(v)} kind={String(v)} />,
  type: (v) => <Pill label={String(v)} kind={String(v)} />,
  subtype: (v) => <Pill label={String(v)} kind="system" />,
  level: (v) => <Pill label={String(v)} kind="system" />,
  hookEvent: (v) => <Pill label={String(v)} kind="hook" />,
  hookName: (v) => (
    <span className="font-mono text-[11.5px] text-neutral-300">{String(v)}</span>
  ),
  command: (v) => (
    <span
      className="font-mono text-[11.5px] text-cyan-300"
      title={String(v ?? "")}
    >
      {String(v)}
    </span>
  ),
  stop_reason: (v) =>
    v == null ? <PrimitiveValue value={v} /> : <Pill label={String(v)} kind="system" />,
  stop_sequence: (v) =>
    v == null ? <PrimitiveValue value={v} /> : <Pill label={String(v)} kind="system" />,

  // Boolean-ish flags — single-glyph glance
  isSidechain: (v) =>
    v ? <FlagGlyph glyph="⇢" tip="isSidechain" tone="info" /> : <PrimitiveValue value={v} />,
  isMeta: (v) =>
    v ? <FlagGlyph glyph="§" tip="isMeta" tone="warn" /> : <PrimitiveValue value={v} />,
  is_error: (v) => (v ? <Pill label="error" kind="error" /> : <PrimitiveValue value={v} />),
  isSnapshotUpdate: (v) => <PrimitiveValue value={v} />,
  interrupted: (v) => <PrimitiveValue value={v} />,
  isImage: (v) => <PrimitiveValue value={v} />,
  noOutputExpected: (v) => <PrimitiveValue value={v} />,

  // Inline-compact renderers for structured values
  usage: (v) => <TokensValue usage={(v as Record<string, number>) ?? {}} />,
  input: (v) => <ToolInput input={v as Record<string, unknown>} />,
  name: (v) => <ToolName value={String(v ?? "")} />,
  thinking: (v) => <ThinkingPreview value={String(v ?? "")} />,
  signature: (v) => <Signature value={String(v ?? "")} />,
};

// Keys whose values are always rendered through the inline registry even
// when the raw value is an object. Any field NOT in this set with an
// object value falls through to the recursive tree renderer.
// [LAW:one-source-of-truth] The set below is the only knob that decides
// inline-vs-tree for object values.
const INLINE_OBJECT_KEYS = new Set(["usage", "input"]);

// ---- Entry points ---------------------------------------------------------

export function FieldGrid({ obj }: { obj: Record<string, unknown> }) {
  return <FieldGroup entries={Object.entries(obj)} depth={0} />;
}

export function AnyValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || typeof value !== "object") {
    return <PrimitiveValue value={value} />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Dim>[ ]</Dim>;
    return <ArrayGroup items={value} depth={0} />;
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return <Dim>{"{ }"}</Dim>;
  return <FieldGroup entries={Object.entries(obj)} depth={0} />;
}

// ---- Recursive dispatcher -------------------------------------------------

function FieldGroup({ entries, depth }: { entries: [string, unknown][]; depth: number }) {
  if (entries.length === 0) return <Dim>{"{ }"}</Dim>;
  return (
    <div className="flex flex-col gap-0.5">
      {entries.map(([k, v]) => (
        <FieldRow key={k} fieldKey={k} value={v} depth={depth} />
      ))}
    </div>
  );
}

function FieldRow({
  fieldKey,
  value,
  depth,
}: {
  fieldKey: string;
  value: unknown;
  depth: number;
}) {
  const shape = classifyValue(fieldKey, value);

  if (shape === "inline") {
    return <InlineLeaf fieldKey={fieldKey} value={value} />;
  }
  if (shape === "string-block") {
    return <StringBlock fieldKey={fieldKey} value={value as string} />;
  }
  if (shape === "content-array") {
    return (
      <ExpandableField
        fieldKey={fieldKey}
        summary={`[${(value as unknown[]).length}]`}
        depth={depth}
      >
        <ContentArray blocks={value as ContentBlock[]} />
      </ExpandableField>
    );
  }
  if (shape === "array") {
    const arr = value as unknown[];
    return (
      <ExpandableField fieldKey={fieldKey} summary={`[${arr.length}]`} depth={depth}>
        <ArrayGroup items={arr} depth={depth + 1} />
      </ExpandableField>
    );
  }
  // "object" — recurse through FieldGroup
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  return (
    <ExpandableField
      fieldKey={fieldKey}
      summary={objectSummary(keys)}
      depth={depth}
    >
      <FieldGroup entries={Object.entries(obj)} depth={depth + 1} />
    </ExpandableField>
  );
}

type Shape = "inline" | "string-block" | "object" | "array" | "content-array";

function classifyValue(fieldKey: string, value: unknown): Shape {
  // Inline renderer takes precedence for non-object values or whitelisted
  // object keys (usage, input).
  const hasRenderer = fieldKey in FIELD_RENDERERS;
  if (value === null || value === undefined) return "inline";
  if (typeof value !== "object") {
    // Long strings get their own block so the key line stays short and the
    // text flows freely.
    if (typeof value === "string" && value.length > 120) return "string-block";
    return "inline";
  }
  // value is object or array
  if (Array.isArray(value)) {
    if (value.length === 0) return "inline";
    if (fieldKey === "content") return "content-array";
    return "array";
  }
  // Plain object
  if (Object.keys(value).length === 0) return "inline";
  if (hasRenderer && INLINE_OBJECT_KEYS.has(fieldKey)) return "inline";
  return "object";
}

// ---- Leaf rendering -------------------------------------------------------

function InlineLeaf({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  const renderer = FIELD_RENDERERS[fieldKey];
  const rendered = renderer ? renderer(value) : <PrimitiveValue value={value} />;
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <KeyLabel fieldKey={fieldKey} />
      <span className="min-w-0 flex-1 break-words">{rendered}</span>
    </div>
  );
}

// String values that are long enough to warrant their own line. The key
// label sits on its own row and the value flows below with full width.
function StringBlock({ fieldKey, value }: { fieldKey: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <KeyLabel fieldKey={fieldKey} />
      <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-neutral-100 pl-3 border-l border-neutral-800">
        <XMLText text={value} />
      </div>
    </div>
  );
}

function KeyLabel({ fieldKey }: { fieldKey: string }) {
  if (!fieldKey) return null;
  return (
    <span className="font-mono text-[11px] text-neutral-500 shrink-0 whitespace-nowrap">
      {fieldKey}
      <span className="text-neutral-700">:</span>
    </span>
  );
}

// ---- Expandable wrapper ---------------------------------------------------

function ExpandableField({
  fieldKey,
  summary,
  depth,
  children,
}: {
  fieldKey: string;
  summary: string;
  depth: number;
  children: ReactNode;
}) {
  // Default: collapsed past depth 2 to avoid a wall of text. User can click
  // to expand any subtree. [LAW:dataflow-not-control-flow] depth is the
  // signal, not a branch on a "root" flag somewhere.
  const [open, setOpen] = useState(depth < 2);
  return (
    <div className="flex flex-col min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-baseline gap-1.5 text-left rounded px-0.5 hover:bg-neutral-800/40 min-w-0"
      >
        <span className="text-neutral-600 w-3 shrink-0 text-[11px]">
          {open ? "▾" : "▸"}
        </span>
        <span className="font-mono text-[11px] text-neutral-300 whitespace-nowrap">
          {fieldKey}
        </span>
        <span className="font-mono text-[11px] text-neutral-600 truncate">
          {summary}
        </span>
      </button>
      {open && (
        <div className="ml-[0.4rem] mt-0.5 pl-3 border-l border-neutral-800/80">
          {children}
        </div>
      )}
    </div>
  );
}

// Collapsed summary for an object — shows up to 4 key names so the shape is
// visible without expanding.
function objectSummary(keys: string[]): string {
  const SHOW = 4;
  const shown = keys.slice(0, SHOW);
  const more = keys.length - SHOW;
  const body = shown.join(", ");
  return more > 0 ? `{${body}, +${more}}` : `{${body}}`;
}

// ---- Array group ----------------------------------------------------------

function ArrayGroup({ items, depth }: { items: unknown[]; depth: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item, i) => (
        <ArrayItem key={i} idx={i} value={item} depth={depth} />
      ))}
    </div>
  );
}

function ArrayItem({
  idx,
  value,
  depth,
}: {
  idx: number;
  value: unknown;
  depth: number;
}) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-mono text-[11px] text-neutral-600 shrink-0 tabular-nums">
          [{idx}]
        </span>
        <span className="min-w-0 flex-1 break-words">
          <PrimitiveValue value={value} />
        </span>
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const count = isArr ? value.length : Object.keys(value as object).length;
  const summary = isArr ? `[${count}]` : objectSummary(Object.keys(value as object));
  return (
    <ExpandableField fieldKey={`[${idx}]`} summary={summary} depth={depth}>
      {isArr ? (
        <ArrayGroup items={value as unknown[]} depth={depth + 1} />
      ) : (
        <FieldGroup entries={Object.entries(value as object)} depth={depth + 1} />
      )}
    </ExpandableField>
  );
}

// ---- Content blocks -------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function ContentArray({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      {blocks.map((b, i) => (
        <ContentBlockView key={i} block={b} idx={i} />
      ))}
    </div>
  );
}

export function ContentBlockView({
  block,
  idx,
}: {
  block: ContentBlock;
  idx?: number;
}) {
  if (!block || typeof block !== "object" || !block.type) {
    return <AnyValue value={block} />;
  }
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 min-w-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {idx !== undefined && (
          <span className="font-mono text-[11px] text-neutral-600 tabular-nums">
            [{idx}]
          </span>
        )}
        <Pill label={block.type} kind={block.type} />
        {block.type === "tool_use" && block.name && <ToolName value={block.name} />}
        {block.type === "tool_use" && block.id && <IdValue value={block.id} len={10} />}
        {block.type === "tool_result" && block.tool_use_id && (
          <span
            className="font-mono text-[11.5px] text-neutral-500"
            title={block.tool_use_id}
          >
            → {block.tool_use_id.slice(0, 10)}
          </span>
        )}
        {block.type === "tool_result" && block.is_error && (
          <Pill label="error" kind="error" />
        )}
      </div>

      {block.type === "thinking" && (
        <div className="flex flex-col gap-1">
          <ThinkingPreview value={block.thinking ?? ""} />
          {block.signature && <Signature value={block.signature} />}
        </div>
      )}

      {block.type === "tool_use" && (
        <ToolInput input={(block.input as Record<string, unknown>) ?? {}} />
      )}

      {block.type === "text" && (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-100">
          <XMLText text={block.text ?? ""} />
        </div>
      )}

      {block.type === "tool_result" && (
        <div className="max-h-[420px] overflow-auto rounded bg-neutral-950/60 p-2 border-l-2 border-neutral-700">
          {typeof block.content === "string" ? (
            <div className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-neutral-300">
              <XMLText text={block.content} />
            </div>
          ) : (
            <AnyValue value={block.content} />
          )}
        </div>
      )}

      {block.type !== "thinking" &&
        block.type !== "tool_use" &&
        block.type !== "text" &&
        block.type !== "tool_result" && (
          <FieldGroup
            entries={Object.entries(block as unknown as Record<string, unknown>)}
            depth={1}
          />
        )}
    </div>
  );
}

export function FieldByKey({
  fieldKey,
  value,
}: {
  fieldKey: string;
  value: unknown;
}) {
  const renderer = FIELD_RENDERERS[fieldKey];
  if (renderer) return <>{renderer(value)}</>;
  return <AnyValue value={value} />;
}
