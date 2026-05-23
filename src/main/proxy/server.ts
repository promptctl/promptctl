// [LAW:single-enforcer] Sole HTTP request listener for the proxy. Owns the
// per-request lifecycle: read body, call upstream, tee response, emit events.
// [LAW:dataflow-not-control-flow] Same code path on every request — no
// "is this an Anthropic call" branch. Provider-aware logic (when added) will
// dispatch off URL via a registry, not inline branches here.
import http from "node:http";
import { URL } from "node:url";

import type {
  AnthropicMessage,
  ClientInfo,
  HarEntry,
  ProxyEvent,
  SseEvent,
} from "../../shared/proxy-events";
import type { Launch, LaunchId } from "../../shared/types";
import { ResponseAssembler } from "./assembler";
import { resolveRequestClient } from "./client-identity";
import { makeEnvelope, newRequestId } from "./envelope";
import { proxyEventBus } from "./events";
import { parseSseFrame } from "./sse-parser";
import { forward, type UpstreamResponse } from "./upstream";

// ─── Header filtering ──────────────────────────────────────────────────────
// Strip hop-by-hop headers and host (we set our own); strip secrets from
// emitted events but PASS THEM THROUGH to upstream untouched.

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Stripped from the UPSTREAM request only. We force identity encoding upstream
// so we can parse SSE bytes directly — without this, Claude Code's
// `accept-encoding: gzip, br` causes Anthropic to return compressed bytes
// the SSE parser can't tokenize. The client still gets a response (just
// uncompressed); HTTP clients all tolerate missing content-encoding.
// [LAW:dataflow-not-control-flow] One rule, applied unconditionally — no
// "is this an inspectable response" branch.
const STRIPPED_UPSTREAM_REQUEST_HEADERS = new Set([
  "accept-encoding",
]);

const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
]);

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function rawHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    out[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  }
  return out;
}

function upstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (STRIPPED_UPSTREAM_REQUEST_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

// ─── Server lifecycle ──────────────────────────────────────────────────────

export interface ServerConfig {
  port: number; // 0 = OS-assigned
  upstreamTarget: string; // e.g. "https://api.anthropic.com"
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const CLIENT_INFO = Symbol("promptctl.clientInfo");

type ClientSocket = http.IncomingMessage["socket"] & {
  [CLIENT_INFO]?: Promise<ClientInfo>;
};

// Notification path for completed entries (HAR recorder subscribes here).
// We pass entries via a dedicated callback rather than the event bus because
// HarEntry is a derived/synthetic shape, not a wire observation.
export type EntrySink = (entry: HarEntry) => void;

export interface StartOptions extends ServerConfig {
  onEntry: EntrySink;
  // Optional header-based attribution. When provided, requests carrying
  // `X-Promptctl-Launch: <id>` are attributed via the launch registry
  // (O(1), deterministic). Absent or unmatched headers fall back to the
  // existing socket→pid walk. [LAW:single-enforcer] one resolver.
  resolveLaunch?: (id: LaunchId) => Launch | null;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const upstreamBase = new URL(opts.upstreamTarget);
  const resolveLaunch = opts.resolveLaunch ?? (() => null);
  const server = http.createServer((req, res) =>
    handleRequest(req, res, upstreamBase, opts.onEntry, resolveLaunch).catch((err) => {
      // Last-resort error handler — handleRequest emits proxy_error before
      // throwing, so this is just to prevent server crashes.
      console.error("[proxy] unhandled error in handleRequest:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Proxy error: ${(err as Error).message}`);
      } else {
        res.end();
      }
    }),
  );
  // Per-connection ClientInfo cache lives in the socket's symbol slot.
  // The first request on a socket resolves identity (header-first;
  // socket-walk fallback) and caches the result; subsequent requests
  // on the same keep-alive connection reuse it. The header is stable
  // across a connection's lifetime — the launching tool sets the
  // ANTHROPIC_CUSTOM_HEADERS env once.
  // [LAW:single-enforcer] One identity-resolution site per request.

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ─── Per-request handler ───────────────────────────────────────────────────

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBase: URL,
  onEntry: EntrySink,
  resolveLaunch: (id: LaunchId) => Launch | null,
): Promise<void> {
  const requestId = newRequestId();
  // [LAW:dataflow-not-control-flow] One resolver. The header path wins
  // when present and known; the socket walk is the fallback. Cache on
  // the socket so a keep-alive connection's later requests skip the
  // resolution. Publish whichever ClientInfo we ended up with so the
  // Live tab's client list reflects the active row.
  const socket = req.socket as ClientSocket;
  const cached = socket[CLIENT_INFO];
  const clientInfo = await (cached ?? (() => {
    const promise = resolveRequestClient(req, req.socket, resolveLaunch);
    socket[CLIENT_INFO] = promise;
    return promise;
  })());
  proxyEventBus.publishClient(clientInfo);
  const envelope = () => makeEnvelope(requestId, clientInfo.clientId);
  const startedAt = Date.now();
  const startedNs = process.hrtime.bigint();

  // Compose upstream URL: use upstreamBase as origin, request path as target.
  const targetUrl = new URL(req.url ?? "/", upstreamBase).toString();
  const incomingHeaders = rawHeaders(req);

  emit({
    ...envelope(),
    kind: "request_headers",
    method: req.method ?? "GET",
    url: targetUrl,
    headers: safeHeaders(incomingHeaders),
  });

  const body = await readRequestBody(req);
  const parsedBody = parseJsonBody(body);
  emit({
    ...envelope(),
    kind: "request_body",
    body: parsedBody,
  });

  let upstream: UpstreamResponse;
  try {
    upstream = await forward({
      method: req.method ?? "GET",
      url: targetUrl,
      headers: upstreamHeaders(incomingHeaders),
      body: body.length > 0 ? body : null,
    });
  } catch (err) {
    const message = (err as Error).message;
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const detail = cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : "";
    emit({
      ...envelope(),
      kind: "proxy_error",
      error: `${message}${detail}`,
    });
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Upstream error: ${message}${detail}`);
    return;
  }

  emit({
    ...envelope(),
    kind: "response_headers",
    status: upstream.status,
    headers: safeHeaders(upstream.headers),
  });

  // Forward upstream headers verbatim — drop hop-by-hop, let the client see
  // content-type/content-length/etc. Node sets transfer-encoding for us.
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    responseHeaders[k] = v;
  }
  res.writeHead(upstream.status, responseHeaders);

  // Tee the response body: write each chunk to the client AND feed it through
  // the SSE parser pipeline. The parser is best-effort — any parse error is
  // logged but does not interrupt the bytes flowing to the client.
  const isSse = (upstream.headers["content-type"] ?? "").includes("text/event-stream");
  const responseChunks: Buffer[] = [];
  const sseEvents: SseEvent[] = [];
  let assembler: ResponseAssembler | null = null;
  if (isSse) assembler = new ResponseAssembler();

  // SSE wire-format buffering for tee parsing (mirrors SseParser internal
  // buffer logic, but synchronous so we don't impose stream backpressure on
  // the client path).
  let sseBuffer = "";

  for await (const chunk of upstream.body) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    responseChunks.push(buf);
    res.write(buf);

    if (isSse && assembler) {
      sseBuffer += buf.toString("utf8");
      let idx = sseBuffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        try {
          const ev = parseSseFrame(frame);
          if (ev !== null) {
            sseEvents.push(ev);
            assembler.onEvent(ev);
            emit({
              ...envelope(),
              kind: "sse_event",
              sse: ev,
            });
          }
        } catch (err) {
          emit({
            ...envelope(),
            kind: "proxy_error",
            error: `SSE parse error: ${(err as Error).message}`,
          });
        }
        idx = sseBuffer.indexOf("\n\n");
      }
    }
  }
  res.end();

  // Reconstruct + emit response_complete + record HAR.
  let assembledMessage: AnthropicMessage | null = null;
  // [LAW:dataflow-not-control-flow] sseEvents.length === 0 means we never
  // tokenized a frame — usually compression upstream of us, or a non-SSE body
  // mis-labeled as text/event-stream. Either way, fall through to the raw-body
  // path; the assembler can't reconstruct what it never received.
  if (isSse && assembler && sseEvents.length > 0) {
    try {
      assembledMessage = assembler.complete();
      emit({
        ...envelope(),
        kind: "response_complete",
        body: assembledMessage,
      });
    } catch (err) {
      emit({
        ...envelope(),
        kind: "proxy_error",
        error: `Response assembly error: ${(err as Error).message}`,
      });
    }
  } else {
    // Non-SSE response — emit the raw body as-is.
    const bodyText = Buffer.concat(responseChunks).toString("utf8");
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // not JSON — leave as string
    }
    emit({
      ...envelope(),
      kind: "response_complete",
      // For non-SSE responses we still emit response_complete with the raw
      // body. Type assertion is intentional: HAR consumers tolerate any shape
      // here, and we don't want a separate event kind for the rare non-SSE
      // case.
      body: parsed as AnthropicMessage,
    });
  }

  emit({
    ...envelope(),
    kind: "response_done",
  });

  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const entry = buildHarEntry({
    requestId,
    startedAt,
    elapsedMs,
    method: req.method ?? "GET",
    url: targetUrl,
    requestHeaders: incomingHeaders,
    requestBody: parsedBody,
    responseStatus: upstream.status,
    responseHeaders: upstream.headers,
    assembledMessage,
    rawResponseBody: assembledMessage === null ? Buffer.concat(responseChunks) : null,
  });
  onEntry(entry);
}

function emit(event: ProxyEvent): void {
  proxyEventBus.emit(event);
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  const text = buf.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── HAR entry construction ────────────────────────────────────────────────

interface BuildEntryArgs {
  requestId: string;
  startedAt: number;
  elapsedMs: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  assembledMessage: AnthropicMessage | null;
  rawResponseBody: Buffer | null;
}

function buildHarEntry(a: BuildEntryArgs): HarEntry {
  // [LAW:one-source-of-truth] Synthetic non-streaming form — matches cc-dump's
  // HAR format choice. Stored body has stream=false for HAR-viewer clarity;
  // response content is the reconstructed complete message. Replay is event-
  // stream-equivalent, not byte-equivalent.
  const requestBodyForHar =
    typeof a.requestBody === "object" && a.requestBody !== null
      ? { ...(a.requestBody as Record<string, unknown>), stream: false }
      : a.requestBody;
  const requestBodyText = JSON.stringify(requestBodyForHar);

  const responseText = a.assembledMessage
    ? JSON.stringify(a.assembledMessage)
    : a.rawResponseBody?.toString("utf8") ?? "";

  return {
    startedDateTime: new Date(a.startedAt).toISOString(),
    time: a.elapsedMs,
    request: {
      method: a.method,
      url: a.url,
      httpVersion: "HTTP/1.1",
      headers: Object.entries(a.requestHeaders).map(([name, value]) => ({ name, value })),
      queryString: [],
      postData: {
        mimeType: "application/json",
        text: requestBodyText,
      },
      headersSize: -1,
      bodySize: Buffer.byteLength(requestBodyText, "utf8"),
    },
    response: {
      status: a.responseStatus,
      statusText: a.responseStatus === 200 ? "OK" : "",
      httpVersion: "HTTP/1.1",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "content-length", value: String(Buffer.byteLength(responseText, "utf8")) },
        ...Object.entries(a.responseHeaders)
          .filter(([k]) => {
            const lk = k.toLowerCase();
            return (
              lk !== "content-type" &&
              lk !== "content-length" &&
              lk !== "transfer-encoding"
            );
          })
          .map(([name, value]) => ({ name, value })),
      ],
      content: {
        size: Buffer.byteLength(responseText, "utf8"),
        mimeType: "application/json",
        text: responseText,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(responseText, "utf8"),
    },
    cache: {},
    timings: {
      send: 0,
      wait: a.elapsedMs,
      receive: 0,
    },
    _requestId: a.requestId,
  };
}
