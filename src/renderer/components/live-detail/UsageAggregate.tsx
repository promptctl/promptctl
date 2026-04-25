import type { RequestRecord } from "../../../shared/proxy-events";
import { UsageBadges } from "./UsageBadges";
import { sumUsage } from "./usage";

export function UsageAggregate({ records }: { records: RequestRecord[] }) {
  const usage = sumUsage(records);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-900 bg-neutral-950 px-3 py-2">
      <span className="text-neutral-500">
        Totals · {records.length} requests
      </span>
      {/* [LAW:one-source-of-truth] The strip is a projection of currently visible records, not a second totals store. */}
      <UsageBadges usage={usage} size="full" />
    </div>
  );
}
