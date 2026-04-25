// [LAW:dataflow-not-control-flow] The Diff tab is always rendered for the
// selected record; the lineage data decides whether it shows new messages, the
// full root, or an empty turn.
import type { RequestRecord } from "../../../shared/proxy-events";
import { MessageView, messageKey } from "./MessageView";
import type { LineageInfo } from "./lineage";

export function DiffTab({
  record,
  lineage,
}: {
  record: RequestRecord;
  lineage: LineageInfo | null;
}) {
  const parentId = lineage?.parentId ?? null;
  const isRoot = parentId === null;
  const newMessages = lineage?.newMessages ?? [];
  const depth = lineage?.depth ?? 0;
  const headerLabel = isRoot
    ? "Turn root"
    : `Continuation of ${parentId.slice(0, 6)} (depth ${depth})`;
  const cacheNote = cacheCorrelation(record, lineage);
  const baseIndex = isRoot
    ? 0
    : Math.max(0, totalMessages(record) - newMessages.length);

  return (
    <div className="space-y-4 p-4" data-testid="diff-tab">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        <span
          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200"
          data-testid="diff-lineage-label"
        >
          {headerLabel}
        </span>
        <span className="text-neutral-500">
          {isRoot
            ? `${newMessages.length} message${newMessages.length === 1 ? "" : "s"}`
            : `+${newMessages.length} new`}
        </span>
        {/* [LAW:dataflow-not-control-flow] cache chip is data-driven; null becomes a stable hidden node. */}
        <span
          aria-hidden={cacheNote === null}
          data-testid="diff-cache-chip"
          className={
            cacheNote === null
              ? "hidden"
              : cacheNote.warn
                ? "rounded bg-amber-950 px-2 py-0.5 text-amber-300"
                : "rounded bg-green-950 px-2 py-0.5 text-green-300"
          }
          title={cacheNote?.title ?? ""}
        >
          {cacheNote?.label ?? ""}
        </span>
      </div>
      <div className="space-y-2">
        {newMessages.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-4 text-xs text-neutral-500">
            No new messages compared to the parent request.
          </div>
        ) : (
          newMessages.map((message, index) => (
            <MessageView
              key={messageKey(message, baseIndex + index)}
              message={message}
              index={baseIndex + index}
              label={isRoot ? undefined : `new message #${baseIndex + index}`}
            />
          ))
        )}
      </div>
    </div>
  );
}

function totalMessages(record: RequestRecord): number {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return 0;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages.length : 0;
}

function cacheCorrelation(
  record: RequestRecord,
  lineage: LineageInfo | null,
): { label: string; warn: boolean; title: string } | null {
  if (lineage === null || lineage.parentId === null) return null;
  if (lineage.expectedCacheTokens === null) return null;
  const usage = record.assembledResponse?.usage;
  if (!usage) return null;
  const actual = usage.cache_read_input_tokens ?? 0;
  const expected = lineage.expectedCacheTokens;
  const warn = actual < Math.floor(expected * 0.5);
  return {
    label: warn
      ? `cache miss · expected ~${expected}, got ${actual}`
      : `cache hit · ~${actual}/${expected}`,
    warn,
    title: `Parent billable tokens: ${expected}. This request's cache_read_input_tokens: ${actual}.`,
  };
}
