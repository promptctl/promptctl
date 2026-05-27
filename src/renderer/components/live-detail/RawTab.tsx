// [LAW:single-enforcer] The Raw tab is the wire-level surface — it shows
// JSON.stringify of the body verbatim and does its own substring marking
// on that text (per design §8.3). The block-renderer registry's marking
// path doesn't apply here because the raw view is not a block.
import { HighlightedText } from "./blocks";
import type { RequestRecord } from "../../../shared/proxy-events";

export function RawTab({
  record,
  highlightSubstring,
}: {
  record: RequestRecord;
  highlightSubstring?: string;
}) {
  return (
    <div className="space-y-3 p-4">
      <RawBlock
        title="Request body"
        value={record.requestBody}
        defaultOpen
        highlightSubstring={highlightSubstring}
      />
      <RawBlock
        title="Response body"
        value={record.assembledResponse}
        highlightSubstring={highlightSubstring}
      />
    </div>
  );
}

function RawBlock({
  title,
  value,
  defaultOpen = false,
  highlightSubstring,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
  highlightSubstring?: string;
}) {
  const text = JSON.stringify(value, null, 2);
  return (
    <details
      open={defaultOpen}
      className="rounded border border-neutral-800 bg-neutral-950"
    >
      <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-neutral-200">
        <span>{title}</span>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            window.electronAPI.writeClipboard(text);
          }}
          className="ml-auto rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
        >
          Copy
        </button>
      </summary>
      <pre className="max-h-[28rem] overflow-auto border-t border-neutral-900 p-3 text-xs text-neutral-300">
        <HighlightedText text={text} query={highlightSubstring ?? ""} />
      </pre>
    </details>
  );
}
