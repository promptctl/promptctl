// @vitest-environment node
//
// Verifies requirements #1 and #2 from the plan:
//   1. Test fixture launches the proxy and sends a request via SSL upstream.
//   2. Reverse proxy sends traffic through to any HTTPS endpoint correctly,
//      and SSL works (the fact that the upstream handler ran proves the
//      TLS handshake succeeded).
//
// Strategy: ephemeral self-signed cert (no fixture certs in repo), local
// HTTPS upstream on 127.0.0.1:0, plain-HTTP request to the proxy listener.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import https from "node:https";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import selfsigned from "selfsigned";

import { startServer, type RunningServer } from "./server";
import { HarRecorder } from "./har-recorder";
import { proxyEventBus } from "./events";
import type { ProxyEvent } from "../../shared/proxy-events";

interface UpstreamFixture {
  origin: string;
  close(): Promise<void>;
  lastRequest: { method: string; path: string; headers: Record<string, string>; body: string } | null;
}

let cert: { key: string; cert: string };

beforeAll(async () => {
  // Generate ONE cert for all tests in this file — generation is the slow part.
  // selfsigned 5.x's generate() is async (returns a Promise).
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      keySize: 2048,
      // 1 day from now is plenty for tests.
      notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 7, ip: "127.0.0.1" },
            { type: 2, value: "localhost" },
          ],
        },
      ],
    },
  );
  cert = { key: pems.private, cert: pems.cert };
});

async function spawnHttpsUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamFixture> {
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("upstream addr");
  return {
    origin: `https://127.0.0.1:${addr.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    lastRequest: null,
  };
}

let tmpDir: string;
let proxy: RunningServer | null = null;
let upstream: UpstreamFixture | null = null;
let recorder: HarRecorder | null = null;
const collectedEvents: ProxyEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "promptctl-proxy-it-"));
  collectedEvents.length = 0;
  unsubscribe = proxyEventBus.subscribe((ev) => collectedEvents.push(ev));
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  if (proxy) {
    await proxy.close();
    proxy = null;
  }
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
  if (recorder) {
    await recorder.drain();
    recorder = null;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

async function postJson(
  port: number,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

describe("proxy integration", () => {
  it("forwards a non-streaming request to an HTTPS upstream and records HAR (req #1, #2)", async () => {
    interface ReceivedRequest {
      method: string;
      url: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }
    // Use a mutable container so TS doesn't narrow `received.value` to `null`
    // based on the local variable's initialization site (assignment happens
    // inside an async closure that TS can't see through).
    const received: { value: ReceivedRequest | null } = { value: null };

    upstream = await spawnHttpsUpstream(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      received.value = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const responseBody = JSON.stringify({ id: "msg_1", role: "assistant", text: "ok" });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(responseBody)),
      });
      res.end(responseBody);
    });

    const localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });

    const result = await postJson(proxy.port, "/v1/messages", {
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }, {
      "x-api-key": "sk-test-secret",
      "anthropic-version": "2023-06-01",
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: "msg_1", role: "assistant", text: "ok" });

    // The upstream handler ran => TLS handshake to the upstream succeeded.
    const got = received.value;
    if (!got) throw new Error("upstream handler did not run");
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/v1/messages");
    // x-api-key was forwarded to upstream verbatim, even though it's stripped
    // from the emitted event headers.
    expect(got.headers["x-api-key"]).toBe("sk-test-secret");
    expect(JSON.parse(got.body)).toMatchObject({ model: "claude-opus-4-7" });

    // HAR was written exactly once (one session => one file, lazy creation).
    await localRecorder.drain();
    const harPath = localRecorder.getCurrentPath();
    if (!harPath) throw new Error("HAR not written");
    const harContent = JSON.parse(await readFile(harPath, "utf8"));
    expect(harContent.log.version).toBe("1.2");
    expect(harContent.log.entries).toHaveLength(1);
    expect(harContent.log.entries[0].request.method).toBe("POST");
    expect(harContent.log.entries[0].response.status).toBe(200);

    // Only ONE HAR file in the recordings dir for this session.
    const files = (await readdir(tmpDir)).filter((f) => f.endsWith(".har"));
    expect(files).toHaveLength(1);

    // Emitted events: secrets stripped from request_headers.
    const reqHeaderEvents = collectedEvents.filter((e) => e.kind === "request_headers");
    expect(reqHeaderEvents).toHaveLength(1);
    expect(collectedEvents.every((e) => e.clientId.length > 0)).toBe(true);
    if (reqHeaderEvents[0].kind === "request_headers") {
      expect(reqHeaderEvents[0].headers["x-api-key"]).toBeUndefined();
      expect(reqHeaderEvents[0].headers["anthropic-version"]).toBe("2023-06-01");
    }
  });

  it("forwards a streaming SSE response, parses events, and assembles message", async () => {
    upstream = await spawnHttpsUpstream(async (req, res) => {
      // Drain request body then stream a canned SSE response.
      for await (const _ of req) void _;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-opus-4-7","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n');
      res.end(sse);
    });

    const localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });

    const result = await postJson(proxy.port, "/v1/messages", {
      model: "claude-opus-4-7",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain("event: message_start"); // raw SSE reached client

    // Wait a tick for response_complete + HAR flush.
    await localRecorder.drain();

    // HAR contains synthetic non-streaming reconstruction.
    const harPath = localRecorder.getCurrentPath();
    if (!harPath) throw new Error("HAR not written");
    const harContent = JSON.parse(await readFile(harPath, "utf8"));
    const respText = JSON.parse(harContent.log.entries[0].response.content.text);
    expect(respText).toMatchObject({
      id: "msg_stream",
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
    });

    // Request body in HAR has stream:false (synthetic non-streaming form).
    const reqText = JSON.parse(harContent.log.entries[0].request.postData.text);
    expect(reqText.stream).toBe(false);

    // Event bus saw individual sse_event entries.
    const sseEvents = collectedEvents.filter((e) => e.kind === "sse_event");
    expect(sseEvents.length).toBeGreaterThanOrEqual(6);

    const completeEvent = collectedEvents.find((e) => e.kind === "response_complete");
    expect(completeEvent).toBeDefined();
    if (completeEvent?.kind === "response_complete") {
      expect(completeEvent.body.content).toEqual([{ type: "text", text: "Hello world" }]);
    }
  });

  it("strips accept-encoding from upstream so SSE bytes parse correctly", async () => {
    // Regression: if accept-encoding is forwarded, Anthropic returns gzip/br
    // bytes the SSE parser can't tokenize, and the assembler never sees a
    // message_start. We force identity by stripping accept-encoding.
    let upstreamAcceptEncoding: string | undefined;
    upstream = await spawnHttpsUpstream(async (req, res) => {
      upstreamAcceptEncoding = req.headers["accept-encoding"] as string | undefined;
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n'),
      );
    });

    const localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });

    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Client requests compression — the proxy must NOT forward this.
        "accept-encoding": "gzip, br",
      },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [], stream: true }),
    }).then((r) => r.text());

    expect(upstreamAcceptEncoding).toBeUndefined();

    // No proxy_error events should have been emitted.
    const errors = collectedEvents.filter((e) => e.kind === "proxy_error");
    expect(errors).toEqual([]);

    // response_complete should carry an actual assembled body, not the raw text.
    const complete = collectedEvents.find((e) => e.kind === "response_complete");
    expect(complete).toBeDefined();
    if (complete?.kind === "response_complete") {
      expect(complete.body).toMatchObject({ id: "msg_x", type: "message" });
    }
  });

  it("does NOT write a HAR file when no requests were made (lazy creation)", async () => {
    // No upstream needed — we make no requests.
    const localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: "https://127.0.0.1:1",
      onEntry: (e) => localRecorder.appendEntry(e),
    });
    // Do nothing — no requests made.
    await new Promise((r) => setTimeout(r, 50));
    expect(localRecorder.getCurrentPath()).toBeNull();
    const files = (await readdir(tmpDir)).filter((f) => f.endsWith(".har"));
    expect(files).toHaveLength(0);
  });
});
