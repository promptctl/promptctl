import type {
  AnthropicUsage,
  RequestRecord,
} from "../../../shared/proxy-events";

export interface UsageShares {
  freshInput: number;
  cacheCreation: number;
  cacheRead: number;
}

const EMPTY_SHARES: UsageShares = {
  freshInput: 0,
  cacheCreation: 0,
  cacheRead: 0,
};

export function sumUsage(records: RequestRecord[]): AnthropicUsage | null {
  const usages = records
    .map((record) => record.assembledResponse?.usage ?? null)
    .filter((usage): usage is AnthropicUsage => usage !== null);

  if (usages.length === 0) return null;

  // [LAW:one-source-of-truth] Aggregate tokens are derived from each record's canonical assembled response usage.
  return usages.reduce<AnthropicUsage>(
    (sum, usage) => ({
      input_tokens: sum.input_tokens + usage.input_tokens,
      output_tokens: sum.output_tokens + usage.output_tokens,
      cache_read_input_tokens:
        (sum.cache_read_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens:
        (sum.cache_creation_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  );
}

export function cacheRatio(usage: AnthropicUsage | null): number | null {
  const freshInput = usage?.input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const total = freshInput + cacheCreation + cacheRead;

  if (usage === null || total === 0) return null;
  return cacheRead / total;
}

export function usageShares(usage: AnthropicUsage | null): UsageShares {
  const freshInput = usage?.input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const total = freshInput + cacheCreation + cacheRead;

  if (usage === null || total === 0) return EMPTY_SHARES;

  // [LAW:single-enforcer] Cache share math lives here so every token surface uses the same proportions.
  return {
    freshInput: freshInput / total,
    cacheCreation: cacheCreation / total,
    cacheRead: cacheRead / total,
  };
}

export function formatToken(n: number | null | undefined): string {
  if (n === null || n === undefined) return "…";
  if (Math.abs(n) >= 999_500) return compact(n, 1_000_000, "m");
  if (Math.abs(n) >= 1_000) return compact(n, 1_000, "k");
  return String(n);
}

function compact(n: number, divisor: number, suffix: string): string {
  return `${(n / divisor).toFixed(1).replace(/\.0$/, "")}${suffix}`;
}
