// [LAW:one-source-of-truth] Lineage is a pure projection of RequestRecord[];
// no parallel store. [LAW:single-enforcer] all lineage rules live here so the
// row indenter and the Diff tab agree on parentage.
import type { RequestRecord } from "../../../shared/proxy-events";

const LINEAGE_WINDOW_NS = 5 * 60 * 1_000_000_000;

export interface LineageInfo {
  parentId: string | null;
  rootId: string;
  depth: number;
  newMessages: unknown[];
  expectedCacheTokens: number | null;
}

export function computeLineage(
  records: RequestRecord[],
): Map<string, LineageInfo> {
  const sorted = [...records].sort((a, b) => a.startedNs - b.startedNs);
  const result = new Map<string, LineageInfo>();

  for (let bIdx = 0; bIdx < sorted.length; bIdx++) {
    const record = sorted[bIdx];
    const messages = getMessages(record);
    const model = getModel(record);
    let parent: RequestRecord | null = null;

    if (messages !== null && model !== null) {
      for (let aIdx = bIdx - 1; aIdx >= 0; aIdx--) {
        const candidate = sorted[aIdx];
        if (candidate.clientId !== record.clientId) continue;
        if (getModel(candidate) !== model) continue;
        if (candidate.completedNs === null) continue;
        if (record.startedNs - candidate.completedNs > LINEAGE_WINDOW_NS)
          continue;
        const candidateMessages = getMessages(candidate);
        if (candidateMessages === null) continue;
        if (candidateMessages.length >= messages.length) continue;
        if (!isPrefix(candidateMessages, messages)) continue;
        parent = candidate;
        break;
      }
    }

    if (parent === null) {
      result.set(record.requestId, {
        parentId: null,
        rootId: record.requestId,
        depth: 0,
        newMessages: messages ?? [],
        expectedCacheTokens: null,
      });
      continue;
    }

    const parentInfo = result.get(parent.requestId);
    const parentMessages = getMessages(parent) ?? [];
    const parentUsage = parent.assembledResponse?.usage ?? null;
    result.set(record.requestId, {
      parentId: parent.requestId,
      rootId: parentInfo?.rootId ?? parent.requestId,
      depth: (parentInfo?.depth ?? 0) + 1,
      newMessages: (messages ?? []).slice(parentMessages.length),
      expectedCacheTokens:
        parentUsage === null
          ? null
          : (parentUsage.input_tokens ?? 0) +
            (parentUsage.output_tokens ?? 0) +
            (parentUsage.cache_read_input_tokens ?? 0) +
            (parentUsage.cache_creation_input_tokens ?? 0),
    });
  }

  return result;
}

function getMessages(record: RequestRecord): unknown[] | null {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : null;
}

function getModel(record: RequestRecord): string | null {
  const body = record.requestBody;
  if (typeof body !== "object" || body === null) return null;
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function isPrefix(short: unknown[], long: unknown[]): boolean {
  if (short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (JSON.stringify(short[i]) !== JSON.stringify(long[i])) return false;
  }
  return true;
}
