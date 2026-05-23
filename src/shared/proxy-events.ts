// [LAW:one-source-of-truth] Canonical proxy event shapes for the entire app.
// Both main (emit) and renderer (consume via IPC) import from here.
// [LAW:one-type-per-behavior] Live and replay produce the same ProxyEvent shape;
// downstream code never branches on "is this a replay".

// ─── Anthropic SSE event types ─────────────────────────────────────────────
// Mirrors the Anthropic Messages API streaming protocol. See:
//   docs/anthropic-api/ANTHROPIC-MESSAGES-API.md
//   docs/anthropic-api/ANTHROPIC-MESSAGES-API-REFERENCE.md (Raw* event types)
//
// `ping` events are dropped at the parse boundary (return null) and never
// surface as SseEvent values.

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessageInfo {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// Content block start payloads — identified by `type` per Anthropic's schema.
export type ContentBlockStart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  // [LAW:dataflow-not-control-flow] Unknown block types pass through opaquely
  // (e.g. "thinking" — surfaces in newer model outputs). The assembler treats
  // them as inert: it never accumulates deltas into them in v1.
  | { type: string; [key: string]: unknown };

// Content block delta payloads — identified by `type`.
export type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: string; [key: string]: unknown };

// [LAW:dataflow-not-control-flow] Discriminator is `type` (matches Anthropic's
// wire format), so we can pass parsed event payloads through as-is.
export type SseEvent =
  | { type: "message_start"; message: AnthropicMessageInfo }
  | { type: "content_block_start"; index: number; content_block: ContentBlockStart }
  | { type: "content_block_delta"; index: number; delta: ContentBlockDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null; stop_sequence: string | null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" };

// ─── Reconstructed (synthetic non-streaming) Anthropic message ────────────
// What the assembler produces at message_stop, and what HAR stores as the
// response.content.text. Matches the non-streaming response shape so HAR
// viewers and replay produce identical output to a stream=false request.

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ─── Pipeline events (the canonical bus payload) ──────────────────────────
// [LAW:single-enforcer] All proxy observations flow through this union.
// requestId/globalSeq/recvNs envelope appears on every variant (no inheritance in
// TS unions) — use makeEnvelope() to construct consistently.

export interface ProxyEventEnvelope {
  requestId: string;
  clientId: string;
  globalSeq: number;
  recvNs: number;
}

export type ProxyEvent =
  | (ProxyEventEnvelope & {
      kind: "request_headers";
      method: string;
      url: string;
      headers: Record<string, string>;
    })
  | (ProxyEventEnvelope & { kind: "request_body"; body: unknown })
  | (ProxyEventEnvelope & {
      kind: "response_headers";
      status: number;
      headers: Record<string, string>;
    })
  | (ProxyEventEnvelope & { kind: "sse_event"; sse: SseEvent })
  | (ProxyEventEnvelope & { kind: "response_complete"; body: AnthropicMessage })
  | (ProxyEventEnvelope & { kind: "response_done" })
  | (ProxyEventEnvelope & { kind: "proxy_error"; error: string });

export interface ClientInfo {
  clientId: string;
  pid: number | null;
  rootPid: number | null;
  displayName: string;
  command: string | null;
  cwd: string | null;
  lastSeenNs: number;
  // Non-null when the request carried `X-Promptctl-Launch: <id>` and
  // that id matches a row in the launch registry. Header-based
  // attribution is O(1) and authoritative for traffic from tools
  // promptctl itself spawned — the socket→pid walk is only the
  // fallback path for untagged traffic. [LAW:single-enforcer]
  launchId: string | null;
}

export type RequestRecordState = "in_flight" | "streaming" | "complete" | "errored";

export interface RequestRecord {
  requestId: string;
  clientId: string;
  method: string;
  url: string;
  status: number | null;
  startedNs: number;
  firstByteNs: number | null;
  completedNs: number | null;
  endedNs: number | null;
  requestBody: unknown;
  assembledResponse: AnthropicMessage | null;
  error: string | null;
  state: RequestRecordState;
  events: ProxyEvent[];
}

// ─── HAR 1.2 shape (the persistent source of truth) ───────────────────────
// Subset sufficient for our use; HAR has many optional fields we omit.

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarHeader[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarTimings {
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  // promptctl extension — request id from the proxy. Standard HAR allows
  // unknown fields, and we use this to round-trip stable request ids.
  _requestId?: string;
}

export interface HarFile {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

// ─── Status payload (broadcast on proxy lifecycle changes) ────────────────

export interface ProxyStatus {
  running: boolean;
  port: number; // 0 when not running
  upstreamTarget: string;
  recordingPath: string | null; // null until first response_complete
  entryCount: number;
}

// Helpers (envelope construction, global sequence counter) live in src/main/proxy/envelope.ts —
// they call Node APIs that aren't available in the renderer.
