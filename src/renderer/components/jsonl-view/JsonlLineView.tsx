// Top-level entry. Accepts the raw JSONL line object and renders a
// composed field-grid view. Callers never pass a JSON string.
//
// [LAW:single-enforcer] One renderer, one surface. If a field needs a
// bespoke look, add an entry to FIELD_RENDERERS — don't branch on caller.
//
// [LAW:dataflow-not-control-flow] highlightSubstring flows in as a value
// on the context, not as a prop threaded through every recursive layer.
// Leaf renderers (XMLText) read the context and apply splitHighlights
// uniformly; an empty query is the "no highlights" identity, so there
// is no "is search active" branch anywhere downstream.

import { HighlightQueryProvider } from "../highlight";
import { AnyValue, FieldGrid } from "./FieldRenderers";

export function JsonlLineView({
  raw,
  highlightSubstring = "",
}: {
  raw: unknown;
  highlightSubstring?: string;
}) {
  return (
    <HighlightQueryProvider query={highlightSubstring}>
      <JsonlLineBody raw={raw} />
    </HighlightQueryProvider>
  );
}

function JsonlLineBody({ raw }: { raw: unknown }) {
  if (raw === null || raw === undefined) {
    return (
      <div className="p-4 text-sm text-neutral-600 italic">No content.</div>
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return (
      <div className="p-3">
        <AnyValue value={raw} />
      </div>
    );
  }
  return (
    <div className="p-3">
      <FieldGrid obj={raw as Record<string, unknown>} />
    </div>
  );
}
