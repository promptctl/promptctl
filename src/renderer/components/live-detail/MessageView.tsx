// [LAW:single-enforcer] Single message renderer for the Request tab and the
// Diff tab. Per-block rendering dispatches through `renderBlock` (blocks.tsx)
// — this file owns the message envelope (role chip, label, expand state).
import { JsonlLineView } from "../jsonl-view/JsonlLineView";
import { blockKey, renderBlock } from "./blocks";

export function MessageView({
  message,
  index,
  label,
}: {
  message: unknown;
  index: number;
  label?: string;
}) {
  const body = asRecord(message);
  const role = typeof body?.role === "string" ? body.role : "unknown";
  const content = body?.content;
  return (
    <details
      open
      className="rounded border border-neutral-800 bg-neutral-950"
      data-testid="request-message"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm text-neutral-200">
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
          {role}
        </span>
        <span className="ml-2 text-neutral-500">
          {label ?? `message #${index}`}
        </span>
      </summary>
      <div className="border-t border-neutral-900">
        {Array.isArray(content) ? (
          <div className="space-y-2 p-3">
            {content.map((block, blockIndex) => (
              <div key={blockKey(block, blockIndex)}>
                {renderBlock(block, { index: blockIndex })}
              </div>
            ))}
          </div>
        ) : (
          <JsonlLineView raw={content ?? null} />
        )}
      </div>
    </details>
  );
}

export function messageKey(message: unknown, index: number): string {
  const body = asRecord(message);
  return typeof body?.id === "string" ? body.id : `message-${index}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
