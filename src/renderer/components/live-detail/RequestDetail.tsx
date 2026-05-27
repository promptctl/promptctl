import { useEffect, useRef, useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { ChainDiffTab } from "./ChainDiffTab";
import { ConversationTab } from "./ConversationTab";
import { DiffTab } from "./DiffTab";
import { tabClass } from "./format";
import type { LineageInfo } from "./lineage";
import { OverviewTab } from "./OverviewTab";
import { RawTab } from "./RawTab";
import { RequestTab } from "./RequestTab";
import { ResponseTab } from "./ResponseTab";
import { SseTimelineTab } from "./SseTimelineTab";
import { ChainSparkline } from "./ChainSparkline";
import { useLiveTickNs } from "./latency";
import { OpenPaneButton } from "./OpenPaneButton";
import { ChainStopReasonStrip, StopReasonChip } from "./stop-reason";

type TabId =
  | "overview"
  | "request"
  | "conversation"
  | "diff"
  | "chain"
  | "response"
  | "timeline"
  | "raw";

// [LAW:one-source-of-truth] Tab order is defined here; the rendered
// content map below mirrors it. Conversation sits between Request and
// Diff per design doc §3.1; Chain sits after Diff per §9.2 — "Diff" is
// the per-request "new bits", "Chain" is the chain-wide prompt+tools
// evolution.
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "request", label: "Request" },
  { id: "conversation", label: "Conversation" },
  { id: "diff", label: "Diff" },
  { id: "chain", label: "Chain" },
  { id: "response", label: "Response" },
  { id: "timeline", label: "SSE Timeline" },
  { id: "raw", label: "Raw" },
];

export function RequestDetail({
  record,
  lineage = null,
  chain = null,
  highlightQuery = "",
  onSelectRequest,
}: {
  record: RequestRecord;
  lineage?: LineageInfo | null;
  chain?: RequestRecord[] | null;
  highlightQuery?: string;
  onSelectRequest?: (requestId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const nowNs = useLiveTickNs();
  const stopReason =
    record.assembledResponse?.stop_reason ??
    (record.state === "complete" ? "end_turn" : null);

  // [LAW:single-enforcer] One auto-scroll effect across all detail tabs.
  // Every tab marks search hits with the canonical
  // <mark data-testid="search-highlight"> via HighlightedText, so a single
  // querySelector on the shared scroll container works for any active tab.
  // Deps: activeTab (user switched surfaces), highlightQuery (query
  // changed), record.requestId (a different request loaded). chain.length
  // covers the case where the Chain/Conversation tabs gain content as a
  // new request joins the chain. jsdom-safe via the scrollIntoView guard.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const chainLength = chain?.length ?? 0;
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null) return;
    if (highlightQuery === "") return;
    const anchor = container.querySelector<HTMLElement>(
      `[data-testid="search-highlight"]`,
    );
    if (anchor && typeof anchor.scrollIntoView === "function") {
      anchor.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [activeTab, highlightQuery, record.requestId, chainLength]);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-200">
            {record.method || "?"} {record.url || "(unknown url)"}
          </div>
          {/* [LAW:no-defensive-null-guards] OpenPaneButton renders only when
              the request's launchId maps to a known launch row. Untagged
              traffic and replays produce no button — pointing at "the
              first pane" would be wrong, so absence is the correct UI. */}
          <OpenPaneButton clientId={record.clientId} />
          {/* [LAW:single-enforcer] stop_reason styling lives in stop-reason.tsx; this is one of two callsites. */}
          <StopReasonChip
            stopReason={stopReason}
            testId="request-stop-reason-chip"
          />
        </div>
        {/* [LAW:dataflow-not-control-flow] chain strip always renders; an empty/single-entry chain is a stable rendered state. */}
        <div
          aria-hidden={chain === null || chain.length <= 1}
          className={chain === null || chain.length <= 1 ? "hidden" : "mb-3"}
        >
          {chain !== null && chain.length > 1 && onSelectRequest ? (
            <div className="flex items-center gap-3">
              <ChainStopReasonStrip
                chain={chain}
                selectedRequestId={record.requestId}
                onSelectRequest={onSelectRequest}
              />
              <ChainSparkline
                chain={chain}
                selectedRequestId={record.requestId}
                onSelectRequest={onSelectRequest}
                nowNs={nowNs}
              />
            </div>
          ) : null}
        </div>
        <ErrorBanner error={record.error} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={tabClass(activeTab === tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        data-testid="request-detail-scroll"
        className="min-h-0 flex-1 overflow-auto"
      >
        {/* [LAW:dataflow-not-control-flow] The tab strip is fixed; selected projection content varies by activeTab data. */}
        {activeTab === "overview" && <OverviewTab record={record} />}
        {activeTab === "request" && (
          <RequestTab
            requestBody={record.requestBody}
            highlightSubstring={highlightQuery}
          />
        )}
        {activeTab === "conversation" && (
          <ConversationTab
            chain={chain}
            selectedRequestId={record.requestId}
            highlightSubstring={highlightQuery}
            onSelectRequest={onSelectRequest}
          />
        )}
        {activeTab === "diff" && <DiffTab record={record} lineage={lineage} />}
        {activeTab === "chain" && (
          <ChainDiffTab
            chain={chain}
            selectedRequestId={record.requestId}
            highlightSubstring={highlightQuery}
            onSelectRequest={onSelectRequest}
          />
        )}
        {activeTab === "response" && (
          <ResponseTab record={record} highlightSubstring={highlightQuery} />
        )}
        {activeTab === "timeline" && <SseTimelineTab record={record} />}
        {activeTab === "raw" && (
          <RawTab record={record} highlightSubstring={highlightQuery} />
        )}
      </div>
    </section>
  );
}

function ErrorBanner({ error }: { error: string | null }) {
  const hasError = error !== null;
  return (
    // [LAW:dataflow-not-control-flow] The error surface always exists; record.error controls visibility and content.
    <div
      aria-hidden={!hasError}
      className={`mb-3 rounded border px-3 py-2 text-xs ${
        hasError
          ? "border-red-800 bg-red-950 text-red-200"
          : "hidden border-transparent"
      }`}
    >
      <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-wide text-red-300">
        Request failed
      </div>
      <div className="break-words font-mono">{error ?? "--"}</div>
    </div>
  );
}
