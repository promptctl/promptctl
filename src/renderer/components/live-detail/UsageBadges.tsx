import type { AnthropicUsage } from "../../../shared/proxy-events";
import { formatToken, usageShares } from "./usage";

type UsageBadgeSize = "compact" | "full";
interface UsageField {
  key: "input" | "cache-creation" | "cache-read" | "output";
  label: string;
  value: number | null | undefined;
  className: string;
  title: string;
}

export function UsageBadges({
  usage,
  size = "compact",
}: {
  usage: AnthropicUsage | null;
  size?: UsageBadgeSize;
}) {
  const fields = usageFields(usage);
  const shares = usageShares(usage);
  const barTitle =
    usage === null
      ? "No usage yet"
      : `fresh ${percent(shares.freshInput)} · cache+ ${percent(
          shares.cacheCreation,
        )} · cache· ${percent(shares.cacheRead)}`;
  const barWidth = size === "full" ? "w-40" : "w-24";

  return (
    <div
      className={`inline-flex min-w-0 ${
        size === "full"
          ? "items-center gap-3"
          : "flex-col items-stretch gap-1 justify-self-end"
      }`}
      data-testid="usage-badges"
    >
      <span className="inline-flex flex-wrap items-center justify-end gap-1">
        {fields.map((field) => (
          <UsagePill key={field.key} field={field} />
        ))}
      </span>
      <span
        className={`flex h-2 ${barWidth} overflow-hidden rounded-sm border border-neutral-700 bg-neutral-950`}
        title={barTitle}
        data-testid="usage-cache-bar"
      >
        {/* [LAW:dataflow-not-control-flow] Segments are always present; missing usage is represented as zero-width data. */}
        <span
          className="h-full bg-green-500"
          style={{ width: percent(shares.cacheRead) }}
          data-share={shares.cacheRead}
          data-testid="usage-segment-cache-read"
        />
        <span
          className="h-full bg-amber-500"
          style={{ width: percent(shares.cacheCreation) }}
          data-share={shares.cacheCreation}
          data-testid="usage-segment-cache-creation"
        />
        <span
          className="h-full bg-neutral-500"
          style={{ width: percent(shares.freshInput) }}
          data-share={shares.freshInput}
          data-testid="usage-segment-input"
        />
      </span>
    </div>
  );
}

function UsagePill({ field }: { field: UsageField }) {
  const formatted = formatToken(field.value);
  const title =
    field.value === null || field.value === undefined
      ? field.title
      : `${field.title}: ${field.value.toLocaleString()} tokens`;

  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded px-1.5 text-[0.65rem] leading-none ${field.className}`}
      title={title}
      data-testid={`usage-pill-${field.key}`}
    >
      <span className="text-neutral-500">{field.label}</span>
      <span className="font-mono tabular-nums">{formatted}</span>
    </span>
  );
}

function usageFields(usage: AnthropicUsage | null): UsageField[] {
  // [LAW:single-enforcer] Label ordering and color mapping are defined once for row, detail, and aggregate usage.
  return [
    {
      key: "input",
      label: "in",
      value: usage?.input_tokens,
      className: "bg-neutral-900 text-neutral-300",
      title: "input tokens",
    },
    {
      key: "cache-creation",
      label: "cache+",
      value: usage?.cache_creation_input_tokens,
      className: "bg-amber-950 text-amber-400",
      title: "cache creation input tokens",
    },
    {
      key: "cache-read",
      label: "cache·",
      value: usage?.cache_read_input_tokens,
      className: "bg-green-950 text-green-400",
      title: "cache read input tokens",
    },
    {
      key: "output",
      label: "out",
      value: usage?.output_tokens,
      className: "bg-neutral-900 text-neutral-300",
      title: "output tokens",
    },
  ];
}

function percent(value: number): string {
  return `${Number.isFinite(value) ? value * 100 : 0}%`;
}
