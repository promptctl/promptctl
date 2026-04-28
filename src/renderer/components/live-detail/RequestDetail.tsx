import { useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { DiffTab } from "./DiffTab";
import { tabClass } from "./format";
import type { LineageInfo } from "./lineage";
import { OverviewTab } from "./OverviewTab";
import { RawTab } from "./RawTab";
import { RequestTab } from "./RequestTab";
import { ResponseTab } from "./ResponseTab";
import { SseTimelineTab } from "./SseTimelineTab";
import {
  ChainStopReasonStrip,
  StopReasonChip,
} from "./stop-reason";

type TabId = "overview" | "request" | "diff" | "response" | "timeline" | "raw";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "request", label: "Request" },
  { id: "diff", label: "Diff" },
  { id: "response", label: "Response" },
  { id: "timeline", label: "SSE Timeline" },
  { id: "raw", label: "Raw" },
];

export function RequestDetail({
  record,
  lineage = null,
  chain = null,
  onSelectRequest,
}: {
  record: RequestRecord;
  lineage?: LineageInfo | null;
  chain?: RequestRecord[] | null;
  onSelectRequest?: (requestId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const stopReason =
    record.assembledResponse?.stop_reason ??
    (record.state === "complete" ? "end_turn" : null);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-200">
            {record.method || "?"} {record.url || "(unknown url)"}
          </div>
          {/* [LAW:single-enforcer] stop_reason styling lives in stop-reason.tsx; this is one of two callsites. */}
          <StopReasonChip
            stopReason={stopReason}
            testId="request-stop-reason-chip"
          />
        </div>
        {/* [LAW:dataflow-not-control-flow] chain strip always renders; an empty/single-entry chain is a stable rendered state. */}
        <div
          aria-hidden={chain === null || chain.length <= 1}
          className={
            chain === null || chain.length <= 1 ? "hidden" : "mb-3"
          }
        >
          {chain !== null && chain.length > 1 && onSelectRequest ? (
            <ChainStopReasonStrip
              chain={chain}
              selectedRequestId={record.requestId}
              onSelectRequest={onSelectRequest}
            />
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
      <div className="min-h-0 flex-1 overflow-auto">
        {/* [LAW:dataflow-not-control-flow] The tab strip is fixed; selected projection content varies by activeTab data. */}
        {activeTab === "overview" && <OverviewTab record={record} />}
        {activeTab === "request" && (
          <RequestTab requestBody={record.requestBody} />
        )}
        {activeTab === "diff" && <DiffTab record={record} lineage={lineage} />}
        {activeTab === "response" && <ResponseTab record={record} />}
        {activeTab === "timeline" && <SseTimelineTab record={record} />}
        {activeTab === "raw" && <RawTab record={record} />}
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
