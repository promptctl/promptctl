// Field-level primitive renderers. Every JSONL field value flows through
// one of these components so visual vocabulary stays consistent across the
// entire view. [LAW:one-type-per-behavior] One renderer per field semantic.

import type { ReactNode } from "react";
import { XMLText } from "./XMLText";
import { fmtClockTime, kfmt, pathTail, truncate } from "./utils";

// ---- Shared atoms ---------------------------------------------------------

const MONO = "font-mono text-[11.5px]";

// Inline helper applied via title= so hover reveals the full value. Native
// tooltip is intentional — works cross-platform, survives scroll, no portal
// gymnastics. If hover feel ever matters, swap one component implementation.
function Tip({
  tip,
  children,
  className,
}: {
  tip: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span title={tip} className={className}>
      {children}
    </span>
  );
}

// ---- Opaque handles — recede visually, full value in tooltip -------------

export function IdValue({ value, len = 8 }: { value: string; len?: number }) {
  if (!value) return <Dim>·</Dim>;
  const short = value.slice(0, len);
  return (
    <Tip tip={value} className={`${MONO} text-neutral-500`}>
      {short}
    </Tip>
  );
}

export function TimeValue({ value }: { value: string }) {
  if (!value) return null;
  return (
    <Tip tip={value} className={`${MONO} text-neutral-500 tabular-nums`}>
      {fmtClockTime(value)}
    </Tip>
  );
}

export function PathValue({ value }: { value: string }) {
  if (!value) return null;
  return (
    <Tip tip={value} className={`${MONO} text-neutral-400`}>
      {pathTail(value)}
    </Tip>
  );
}

// ---- Semantic pills ------------------------------------------------------

const PILL_COLORS: Record<string, string> = {
  user: "bg-blue-500/15 text-blue-300",
  assistant: "bg-orange-500/15 text-orange-300",
  system: "bg-neutral-500/15 text-neutral-400",
  branch: "bg-emerald-500/15 text-emerald-300",
  model: "bg-violet-500/15 text-violet-300",
  hook: "bg-cyan-500/15 text-cyan-300",
  usermeta: "bg-amber-500/15 text-amber-300",
  error: "bg-red-500/20 text-red-300",
  tool_use: "bg-violet-500/15 text-violet-300",
  tool_result: "bg-neutral-500/15 text-neutral-400",
  text: "bg-neutral-500/15 text-neutral-300",
  thinking: "bg-purple-500/15 text-purple-300",
};

export function Pill({ label, kind }: { label: string; kind?: string }) {
  const color =
    (kind && PILL_COLORS[kind]) ??
    PILL_COLORS[label] ??
    "bg-neutral-500/15 text-neutral-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${color}`}>
      {label}
    </span>
  );
}

// ---- Token usage — compact arrow form with cache breakdown --------------

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function TokensValue({ usage }: { usage: UsageLike }) {
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const cc = usage.cache_creation_input_tokens ?? 0;
  return (
    <span className={`${MONO} tabular-nums`}>
      <span className="text-emerald-400">{kfmt(inp)}</span>
      <span className="mx-0.5 text-neutral-600">→</span>
      <span className="text-sky-400">{kfmt(out)}</span>
      {(cr || cc) > 0 && (
        <Tip
          tip={`cache read ${cr} / cache create ${cc}`}
          className="ml-1 text-neutral-500"
        >
          ({kfmt(cr)}r/{kfmt(cc)}c)
        </Tip>
      )}
    </span>
  );
}

// ---- Flag glyphs (boolean summaries) -------------------------------------

export function FlagGlyph({
  glyph,
  tip,
  tone = "neutral",
}: {
  glyph: string;
  tip: string;
  tone?: "neutral" | "warn" | "info";
}) {
  const color =
    tone === "warn"
      ? "text-amber-400"
      : tone === "info"
        ? "text-cyan-400"
        : "text-neutral-400";
  return (
    <Tip tip={tip} className={`${color} text-sm font-bold`}>
      {glyph}
    </Tip>
  );
}

// ---- Primitive leaf values ------------------------------------------------

export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-neutral-600 italic">{children}</span>;
}

export function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <Dim>·</Dim>;
  if (typeof value === "boolean") {
    return value ? (
      <Tip tip="true" className="text-emerald-400 font-bold">
        ✓
      </Tip>
    ) : (
      <Tip tip="false" className="text-red-400 font-bold">
        ✗
      </Tip>
    );
  }
  if (typeof value === "number") {
    return <span className={`${MONO} text-sky-300 tabular-nums`}>{value}</span>;
  }
  if (typeof value === "string") {
    if (value === "") return <Dim>(empty)</Dim>;
    // Strings flow through XMLText so paired tags are highlighted at every
    // depth — same treatment as the string-block path. [LAW:one-source-of-truth]
    return (
      <span className="text-neutral-200">
        <XMLText text={value} />
      </span>
    );
  }
  return <span className="text-neutral-400">{String(value)}</span>;
}

// ---- Opaque signature (cryptographic blob — truncate hard) --------------

export function Signature({ value }: { value: string }) {
  const len = value?.length ?? 0;
  return (
    <Tip
      tip={`signature (${len} chars)`}
      className={`${MONO} text-neutral-600`}
    >
      ·sig ({len} ch)
    </Tip>
  );
}

// ---- Thinking preview (truncated, full body in tooltip) -----------------

export function ThinkingPreview({ value }: { value: string }) {
  if (!value) return <Dim>(empty)</Dim>;
  return (
    <Tip tip={value} className="text-purple-300">
      <span className="mr-1 text-purple-400">◐</span>
      <span className="italic">{truncate(value, 120)}</span>
    </Tip>
  );
}

// ---- Tool input (compact key:value chips) --------------------------------

export function ToolInput({
  input,
}: {
  input: Record<string, unknown> | null | undefined;
}) {
  if (!input || typeof input !== "object") return null;
  const entries = Object.entries(input).filter(([k]) => k !== "caller");
  const SHOW = 3;
  const short = entries.slice(0, SHOW);
  const overflow = entries.length - SHOW;

  const fmtV = (v: unknown): string => {
    if (typeof v === "string")
      return v.length > 32 ? `"${v.slice(0, 32)}…"` : `"${v}"`;
    if (typeof v === "boolean") return v ? "✓" : "✗";
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return `[${v.length}]`;
    if (v && typeof v === "object") return "{…}";
    return String(v);
  };
  const fmtTip = (v: unknown): string => {
    if (v === null || v === undefined) return "·";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "✓" : "✗";
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (typeof v === "object") return `{${Object.keys(v).length} keys}`;
    return String(v);
  };
  const tipText = entries.map(([k, v]) => `${k}: ${fmtTip(v)}`).join("\n");

  return (
    <Tip tip={tipText} className={`${MONO} inline-flex items-baseline gap-1.5`}>
      {short.map(([k, v]) => (
        <span key={k} className="inline-flex items-baseline">
          <span className="text-neutral-500">{k}</span>
          <span className="text-neutral-600">:</span>
          <span className="ml-0.5 text-neutral-300">{fmtV(v)}</span>
        </span>
      ))}
      {overflow > 0 && <span className="text-neutral-500">+{overflow}</span>}
    </Tip>
  );
}

// ---- Tool name (high contrast — this is the semantic verb) ---------------

export function ToolName({ value }: { value: string }) {
  return (
    <span className={`${MONO} text-violet-300 font-semibold`}>{value}</span>
  );
}
