// [LAW:dataflow-not-control-flow] Replay synthesizes ProxyEvents through the
// same code path as live capture. Downstream consumers (Live tab, HAR recorder)
// never know whether a given event arrived from the wire or from disk.
//
// Documented divergence vs. live wire (also accepted by cc-dump):
//   - Per text block, one consolidated text_delta is emitted (not the multi-
//     chunk delta sequence the original wire produced).
//   - response_headers content-type is "application/json" (not text/event-stream).
//   - request body in the synthesized request_body event has stream:false
//     (HAR stores the synthetic non-streaming form).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  HarEntry,
  HarFile,
  ProxyEvent,
  SseEvent,
} from "../../shared/proxy-events";
import { makeEnvelope, newRequestId } from "./envelope";
import { proxyEventBus } from "./events";

export async function loadHarFile(filePath: string): Promise<HarEntry[]> {
  const text = await readFile(filePath, "utf8");
  const har = JSON.parse(text) as HarFile;
  if (har.log?.version !== "1.2") {
    throw new Error(`Unsupported HAR version: ${har.log?.version ?? "?"}`);
  }
  return har.log.entries;
}

// [LAW:single-enforcer] All HAR-to-event synthesis lives here. Callers pass
// entries (or a file path); they never compose ProxyEvents from HarEntry
// shapes themselves.
export function synthesizeEvents(
  entry: HarEntry,
  clientId = "replay-unknown",
): ProxyEvent[] {
  const requestId = entry._requestId ?? newRequestId();
  const envelope = () => makeEnvelope(requestId, clientId);
  const events: ProxyEvent[] = [];

  const requestHeaders = entry.request.headers.reduce<Record<string, string>>(
    (acc, h) => {
      acc[h.name] = h.value;
      return acc;
    },
    {},
  );
  const responseHeaders = entry.response.headers.reduce<Record<string, string>>(
    (acc, h) => {
      acc[h.name] = h.value;
      return acc;
    },
    {},
  );

  events.push({
    ...envelope(),
    kind: "request_headers",
    method: entry.request.method,
    url: entry.request.url,
    headers: requestHeaders,
  });

  const reqBodyText = entry.request.postData?.text ?? "";
  let reqBody: unknown = reqBodyText;
  try {
    reqBody = JSON.parse(reqBodyText);
  } catch {
    // not JSON
  }
  events.push({
    ...envelope(),
    kind: "request_body",
    body: reqBody,
  });

  events.push({
    ...envelope(),
    kind: "response_headers",
    status: entry.response.status,
    headers: responseHeaders,
  });

  // Reconstruct synthetic SSE events from the assembled response body, IF the
  // response is an Anthropic message shape. This is what makes replay show as
  // the same event stream the Live tab saw originally.
  const respText = entry.response.content?.text ?? "";
  let respBody: unknown = respText;
  try {
    respBody = JSON.parse(respText);
  } catch {
    // not JSON — emit response_complete with the raw text and skip SSE synth
  }

  if (isAnthropicMessage(respBody)) {
    const sseEvents = messageToSseEvents(respBody);
    for (const sse of sseEvents) {
      events.push({
        ...envelope(),
        kind: "sse_event",
        sse,
      });
    }
    events.push({
      ...envelope(),
      kind: "response_complete",
      body: respBody,
    });
  } else {
    events.push({
      ...envelope(),
      kind: "response_complete",
      body: respBody as AnthropicMessage,
    });
  }

  events.push({
    ...envelope(),
    kind: "response_done",
  });

  return events;
}

// Replay a HAR file's entries through the event bus. Returns the entries so
// the caller can seed the HarRecorder.
export async function replayHarFile(filePath: string): Promise<HarEntry[]> {
  const entries = await loadHarFile(filePath);
  const clientId = `replay-${basename(filePath, ".har")}`;
  proxyEventBus.publishClient({
    clientId,
    pid: null,
    rootPid: null,
    displayName: `Replay ${basename(filePath)}`,
    command: null,
    cwd: filePath,
    lastSeenNs: Number(process.hrtime.bigint()),
    launchId: null,
  });
  for (const entry of entries) {
    for (const ev of synthesizeEvents(entry, clientId)) {
      proxyEventBus.emit(ev);
    }
  }
  return entries;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function isAnthropicMessage(body: unknown): body is AnthropicMessage {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.type === "message" &&
    typeof b.id === "string" &&
    typeof b.model === "string" &&
    Array.isArray(b.content)
  );
}

// [LAW:dataflow-not-control-flow] One consolidated delta per block — the
// documented replay divergence from live (where many small deltas arrive
// per chunk). Downstream code MUST tolerate either flavor.
function messageToSseEvents(msg: AnthropicMessage): SseEvent[] {
  const out: SseEvent[] = [];
  out.push({
    type: "message_start",
    message: {
      id: msg.id,
      type: "message",
      role: msg.role,
      model: msg.model,
      stop_reason: null, // present at message_start; finalized at message_delta
      stop_sequence: null,
      usage: { ...msg.usage, output_tokens: 0 },
    },
  });
  msg.content.forEach((block, index) => {
    out.push(...blockToSseEvents(block, index));
  });
  out.push({
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  out.push({ type: "message_stop" });
  return out;
}

function blockToSseEvents(
  block: AnthropicContentBlock,
  index: number,
): SseEvent[] {
  if (block.type === "text") {
    return [
      {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: (block as { text: string }).text },
      },
      { type: "content_block_stop", index },
    ];
  }
  if (block.type === "tool_use") {
    const tu = block as {
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    return [
      {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(tu.input),
        },
      },
      { type: "content_block_stop", index },
    ];
  }
  // Opaque pass-through: emit start+stop with the raw block. Assembler will
  // accept this without accumulating deltas.
  return [
    {
      type: "content_block_start",
      index,
      content_block: block,
    },
    { type: "content_block_stop", index },
  ];
}
