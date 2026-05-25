// [LAW:one-source-of-truth] PromptBucket is a derived projection of
// RequestRecord[] — no parallel store, no cache. The projection
// re-runs when the request list changes. Bucket membership is
// authoritative because it's recomputed from records, not maintained
// alongside them.
//
// [LAW:dataflow-not-control-flow] Pure function over inputs. Live
// capture and HAR replay feed identical records → identical buckets.
// There is no "is this live" branch.
//
// [LAW:types-are-the-program] A PromptBucket has a non-null hash by
// construction — requests with no system prompt simply don't appear
// in any bucket. The shape carries the invariant; callers never need
// to handle a "bucket without a hash".

import type { RequestRecord } from "../../../shared/proxy-events";
import {
  extractSystem,
  extractTools,
  systemPromptHash,
  toolsHash,
} from "./promptHash";

export interface PromptBucket {
  // The system-prompt hash — the bucket key.
  readonly hash: string;
  // The system value from the most recent sample (display only).
  readonly sampleSystem: unknown;
  // Tools from the most recent sample, plus the tools hash. Two
  // requests can share a system-prompt hash but have different tools;
  // the bucket surfaces the most recent for at-a-glance display.
  readonly sampleTools: unknown[] | null;
  readonly sampleToolsHash: string | null;
  // Aggregate counts and identity.
  readonly count: number;
  readonly clientIds: readonly string[];
  readonly requestIds: readonly string[];
  // Highest startedNs of any contributing request — drives recency
  // sort and "last seen" display.
  readonly lastSeenNs: number;
}

export function bucketBySystemPrompt(
  requests: readonly RequestRecord[],
): PromptBucket[] {
  const accumulators = new Map<string, BucketAccumulator>();

  for (const record of requests) {
    const hash = systemPromptHash(record.requestBody);
    if (hash === null) continue;
    const existing = accumulators.get(hash);
    if (existing === undefined) {
      accumulators.set(hash, {
        hash,
        latestSystem: extractSystem(record.requestBody),
        latestTools: extractTools(record.requestBody),
        latestToolsHash: toolsHash(record.requestBody),
        latestStartedNs: record.startedNs,
        clientIds: new Set([record.clientId]),
        requestIds: [record.requestId],
      });
      continue;
    }
    existing.clientIds.add(record.clientId);
    existing.requestIds.push(record.requestId);
    if (record.startedNs > existing.latestStartedNs) {
      existing.latestStartedNs = record.startedNs;
      existing.latestSystem = extractSystem(record.requestBody);
      existing.latestTools = extractTools(record.requestBody);
      existing.latestToolsHash = toolsHash(record.requestBody);
    }
  }

  return [...accumulators.values()]
    .map(toBucket)
    .sort((a, b) => b.lastSeenNs - a.lastSeenNs);
}

interface BucketAccumulator {
  hash: string;
  latestSystem: unknown;
  latestTools: unknown[] | null;
  latestToolsHash: string | null;
  latestStartedNs: number;
  clientIds: Set<string>;
  requestIds: string[];
}

function toBucket(acc: BucketAccumulator): PromptBucket {
  return {
    hash: acc.hash,
    sampleSystem: acc.latestSystem,
    sampleTools: acc.latestTools,
    sampleToolsHash: acc.latestToolsHash,
    count: acc.requestIds.length,
    clientIds: [...acc.clientIds],
    requestIds: acc.requestIds,
    lastSeenNs: acc.latestStartedNs,
  };
}

// Returns a short, human-readable preview of a system prompt for
// the bucket card. Works on both string and array shapes.
export function systemPreview(system: unknown, maxChars = 160): string {
  const text = systemToText(system);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "…";
}

// Returns the full prompt text — no truncation. Same join semantics
// as systemPreview so the expanded card shows the same content the
// preview is a prefix of.
export function fullPromptText(system: unknown): string {
  return systemToText(system);
}

function systemToText(system: unknown): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (
      block !== null &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push(((block as { text: string }).text || "").trim());
    }
  }
  return parts.join("\n").trim();
}

// Returns the tool names from a tools array (best-effort). Used by
// the bucket card to show "tools: [Bash, Read, …]".
export function toolNames(tools: unknown[] | null): string[] {
  if (tools === null) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (
      tool !== null &&
      typeof tool === "object" &&
      typeof (tool as { name?: unknown }).name === "string"
    ) {
      names.push((tool as { name: string }).name);
    }
  }
  return names;
}
