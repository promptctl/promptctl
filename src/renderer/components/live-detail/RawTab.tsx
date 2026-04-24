import type { RequestRecord } from "../../../shared/proxy-events";

export function RawTab({ record }: { record: RequestRecord }) {
  return (
    <div className="space-y-3 p-4">
      <RawBlock title="Request body" value={record.requestBody} defaultOpen />
      <RawBlock title="Response body" value={record.assembledResponse} />
    </div>
  );
}

function RawBlock({
  title,
  value,
  defaultOpen = false,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
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
        {text}
      </pre>
    </details>
  );
}
