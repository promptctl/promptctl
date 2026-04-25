import type { AnthropicUsage } from "../../../shared/proxy-events";
import { cacheRatio, formatToken, usageShares } from "./usage";

type UsageBadgeSize = "compact" | "full";
interface UsageField {
  key: "input" | "cache-creation" | "cache-read" | "output";
  label: string;
  value: number | null | undefined;
  className: string;
  title: string;
  widthClass: string;
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
  const ratio = cacheRatio(usage);
  const barTitle =
    usage === null
      ? "No usage yet"
      : `cache hit ${ratio === null ? "n/a" : percent(ratio)} · fresh ${percent(
          shares.freshInput,
        )} · cache+ ${percent(
          shares.cacheCreation,
        )} · cache· ${percent(shares.cacheRead)}`;
  const compact = size === "compact";
  const barWidth = compact ? "" : "w-40";

  return (
    <div
      className={`relative inline-flex min-w-0 ${
        compact
          ? "items-center justify-end overflow-visible justify-self-end pb-1"
          : "items-center gap-3"
      }`}
      data-testid="usage-badges"
    >
      <span
        className={`inline-flex min-w-0 items-center justify-end gap-1 ${
          compact ? "flex-nowrap overflow-hidden" : "flex-wrap"
        }`}
      >
        {fields.map((field) => (
          <UsagePill key={field.key} field={field} compact={compact} />
        ))}
      </span>
      <span
        className={`flex h-2 ${barWidth} shrink-0 overflow-hidden rounded-sm border border-neutral-700 bg-neutral-950 ${
          compact ? "absolute bottom-0 left-0 right-0 h-1 w-full" : ""
        }`}
        title={barTitle}
        data-testid="usage-cache-bar"
      >
        {/* [LAW:dataflow-not-control-flow] Segments are always present; missing usage is represented as zero-width data. */}
        {/* [LAW:single-enforcer] Brighter bar fills intentionally reuse the shared cache/share mapping while preserving contrast on the dark track. */}
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

function UsagePill({
  field,
  compact,
}: {
  field: UsageField;
  compact: boolean;
}) {
  const formatted = formatToken(field.value);
  const title =
    field.value === null || field.value === undefined
      ? field.title
      : `${field.title}: ${field.value.toLocaleString()} tokens`;

  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[0.65rem] leading-none ${
        compact ? field.widthClass : ""
      } ${field.className}`}
      title={title}
      data-testid={`usage-pill-${field.key}`}
    >
      <span className="shrink-0 text-neutral-500">{field.label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums">
        {formatted}
      </span>
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
      widthClass: "w-[4rem]",
    },
    {
      key: "cache-creation",
      label: "cache+",
      value: usage?.cache_creation_input_tokens,
      className: "bg-amber-950 text-amber-400",
      title: "cache creation input tokens",
      widthClass: "w-[5rem]",
    },
    {
      key: "cache-read",
      label: "cache·",
      value: usage?.cache_read_input_tokens,
      className: "bg-green-950 text-green-400",
      title: "cache read input tokens",
      widthClass: "w-[5rem]",
    },
    {
      key: "output",
      label: "out",
      value: usage?.output_tokens,
      className: "bg-neutral-900 text-neutral-300",
      title: "output tokens",
      widthClass: "w-[4rem]",
    },
  ];
}

function percent(value: number): string {
  const pct = Number.isFinite(value) ? value * 100 : 0;
  return `${Number(pct.toFixed(2))}%`;
}
