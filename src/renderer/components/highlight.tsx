// [LAW:single-enforcer] One module owns "render text with highlighted
// substring matches". splitHighlights is the segmentation math, the
// HighlightedText component is the DOM contract (<mark
// data-testid="search-highlight">), and HighlightQueryContext is the
// prop-less propagation seam for recursive renderers (JsonlLineView).
// Anywhere a surface needs search-substring marking it consumes from
// here — no bespoke <mark> renderers anywhere in the renderer tree.
//
// [LAW:one-way-deps] Pure module — no imports from feature folders.
// live-detail and jsonl-view both depend on this; this depends on neither.

import { createContext, useContext, type ReactNode } from "react";

export interface HighlightSegment {
  text: string;
  isMatch: boolean;
}

// Split text into alternating {text, isMatch} segments. Query matching
// is case-insensitive but the original case of `text` is preserved
// in the output segments (the user sees the source text, not the
// normalized form).
//
// Empty query (or empty text) yields a single non-match segment for
// the entire string — callers can render the result without a
// query-active branch.
export function splitHighlights(
  text: string,
  normalizedQuery: string,
): HighlightSegment[] {
  if (normalizedQuery === "" || text === "") {
    return [{ text, isMatch: false }];
  }
  const haystack = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  const queryLength = normalizedQuery.length;
  let cursor = 0;
  while (cursor < text.length) {
    const matchIndex = haystack.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), isMatch: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), isMatch: false });
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + queryLength),
      isMatch: true,
    });
    cursor = matchIndex + queryLength;
  }
  return segments;
}

// The canonical mark element. Surfaces query the auto-scroll mechanism
// (RequestDetail) and the e2e selectors by this testid; if it ever
// changes, change it here and every surface follows.
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

// [LAW:dataflow-not-control-flow] Context default is the empty query,
// which splitHighlights interprets as "no match, no marks". Consumers
// don't branch on "is a query active" — they always splitHighlights
// the text and always render segments. Variability lives in the value.
const HighlightQueryContext = createContext<string>("");

export function HighlightQueryProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}): ReactNode {
  return (
    <HighlightQueryContext.Provider value={query}>
      {children}
    </HighlightQueryContext.Provider>
  );
}

export function useHighlightQuery(): string {
  return useContext(HighlightQueryContext);
}
