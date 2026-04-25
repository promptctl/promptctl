import { useState } from "react";
import type { RequestRecord } from "../../../shared/proxy-events";
import { tabClass } from "./format";
import { OverviewTab } from "./OverviewTab";
import { RawTab } from "./RawTab";
import { RequestTab } from "./RequestTab";
import { ResponseTab } from "./ResponseTab";
import { SseTimelineTab } from "./SseTimelineTab";

type TabId = "overview" | "request" | "response" | "timeline" | "raw";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "request", label: "Request" },
  { id: "response", label: "Response" },
  { id: "timeline", label: "SSE Timeline" },
  { id: "raw", label: "Raw" },
];

export function RequestDetail({ record }: { record: RequestRecord }) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="mb-3 min-w-0 truncate font-mono text-sm text-neutral-200">
          {record.method || "?"} {record.url || "(unknown url)"}
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
