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
        {/* [LAW:dataflow-not-control-flow] Every detail tab is always selectable; missing fields render empty values inside the selected projection. */}
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
