// Pair-aware XML highlighter. Given a string like
//   "real prose <local-command-caveat>side note</local-command-caveat> more prose"
// produces React fragments where the inner text of each tag pair is colored
// and carries the tag name in its title attribute.
//
// [LAW:dataflow-not-control-flow] Same render path whether the string has
// zero, one, or many tags — the regex match array is the data that varies.

import { Fragment, type ReactNode } from "react";

const PAIR_RE = /<(\w[\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
const ORPHAN_RE = /<(\/?)([\w-]+)([^>]*?)>/g;

interface Piece {
  kind: "text" | "pair" | "orphan";
  text: string;
  openTag?: string;
  tagName?: string;
  inner?: string;
  closing?: boolean;
}

// Walk the string once, building a flat list of pieces. Text pieces may
// still contain orphan tags — those are broken out in renderPieces.
function tokenizePairs(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PAIR_RE.lastIndex = 0;
  while ((m = PAIR_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: text.slice(last, m.index) });
    }
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    out.push({
      kind: "pair",
      text: m[0],
      openTag,
      tagName: m[1],
      inner: m[2],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

// Break any orphan tags out of a raw text segment into their own pieces.
function tokenizeOrphans(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  ORPHAN_RE.lastIndex = 0;
  while ((m = ORPHAN_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: text.slice(last, m.index) });
    }
    out.push({
      kind: "orphan",
      text: m[0],
      tagName: m[2],
      closing: m[1] === "/",
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

interface XMLTextProps {
  text: string;
}

export function XMLText({ text }: XMLTextProps) {
  if (!text) return null;
  return <>{renderXML(text)}</>;
}

function renderXML(text: string): ReactNode[] {
  const pieces = tokenizePairs(text);
  const nodes: ReactNode[] = [];
  pieces.forEach((p, i) => {
    if (p.kind === "pair" && p.inner !== undefined) {
      const tipText = `${p.openTag}...</${p.tagName}>`;
      // Recurse through inner — nested tags get the same treatment.
      nodes.push(
        <span
          key={`p${i}`}
          title={tipText}
          className="rounded-sm bg-amber-500/10 text-amber-200 px-0.5"
        >
          {renderXML(p.inner)}
        </span>,
      );
    } else if (p.kind === "text") {
      // A text piece may still have orphan tags — turn those into glyphs.
      const subs = tokenizeOrphans(p.text);
      subs.forEach((s, j) => {
        if (s.kind === "orphan") {
          nodes.push(
            <span
              key={`p${i}o${j}`}
              title={s.text}
              className={
                s.closing ? "text-neutral-500" : "text-amber-400/60"
              }
            >
              {s.closing ? "›" : "‹"}
            </span>,
          );
        } else {
          nodes.push(<Fragment key={`p${i}t${j}`}>{s.text}</Fragment>);
        }
      });
    }
  });
  return nodes;
}
