// @vitest-environment node
//
// Verifies requirement #4 from the plan: HAR writer round-trip.
// Capture events from a live proxy run (list A), then load that HAR through
// the replayer and capture its emitted events (list B). The two streams must
// be equivalent modulo the documented divergences (consolidated text deltas,
// content-type, stream:false in request body).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import https from "node:https";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import selfsigned from "selfsigned";

import { startServer, type RunningServer } from "./server";
import { HarRecorder } from "./har-recorder";
import { proxyEventBus } from "./events";
import { replayHarFile } from "./har-replayer";
import type { ClientInfo, ProxyEvent } from "../../shared/proxy-events";

let cert: { key: string; cert: string };

beforeAll(async () => {
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      keySize: 2048,
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

interface UpstreamFixture {
  origin: string;
  close(): Promise<void>;
}

async function spawnHttpsUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamFixture> {
  const server = https.createServer(
    { key: cert.key, cert: cert.cert },
    handler,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null)
    throw new Error("upstream addr");
  return {
    origin: `https://127.0.0.1:${addr.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let tmpDir: string;
let proxy: RunningServer | null = null;
let upstream: UpstreamFixture | null = null;
let recorder: HarRecorder | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeClients: (() => void) | null = null;
let collected: ProxyEvent[] = [];
let collectedClients: ClientInfo[] = [];

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "promptctl-roundtrip-"));
  collected = [];
  collectedClients = [];
  unsubscribe = proxyEventBus.subscribe((ev) => collected.push(ev));
  unsubscribeClients = proxyEventBus.subscribeClients((info) =>
    collectedClients.push(info),
  );
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeClients?.();
  unsubscribeClients = null;
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

const SSE_FIXTURE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_round","type":"message","role":"assistant","model":"claude-opus-4-7","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

describe("HAR round-trip", () => {
  it("live capture → HAR → replay produces equivalent event stream (req #4)", async () => {
    upstream = await spawnHttpsUpstream(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_FIXTURE);
    });

    const localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });

    // ─── Phase A: live capture ────────────────────────────────────────
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }).then((r) => r.text());

    await localRecorder.drain();
    const harPath = localRecorder.getCurrentPath();
    if (!harPath) throw new Error("HAR not written");
    const liveEvents = collected.slice();
    const liveSummary = summarizeStream(liveEvents);

    // ─── Phase B: replay ──────────────────────────────────────────────
    collected = [];
    await replayHarFile(harPath);
    const replayEvents = collected.slice();
    const replaySummary = summarizeStream(replayEvents);

    // Equivalence assertions (modulo documented divergences).
    expect(replaySummary.kinds).toEqual(liveSummary.kinds);
    expect(replaySummary.method).toBe(liveSummary.method);
    expect(replaySummary.url).toBe(liveSummary.url);
    expect(replaySummary.responseStatus).toBe(liveSummary.responseStatus);
    expect(replaySummary.assembledBody).toEqual(liveSummary.assembledBody);
    expect(
      replayEvents.every((event) => event.clientId.startsWith("replay-")),
    ).toBe(true);
    expect(
      collectedClients.some(
        (client) => client.clientId === replayEvents[0]?.clientId,
      ),
    ).toBe(true);
  });

  it("appending after replay keeps a single HAR file with growing entries (req #5b)", async () => {
    // First session: produce one HAR with one entry.
    upstream = await spawnHttpsUpstream(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_FIXTURE);
    });
    let localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [] }),
    }).then((r) => r.text());
    await localRecorder.drain();
    const originalPath = localRecorder.getCurrentPath();
    if (!originalPath) throw new Error("HAR not written in phase 1");
    expect(localRecorder.getEntries()).toHaveLength(1);

    // Stop the proxy, simulate a fresh app start.
    await proxy.close();
    proxy = null;

    // New recorder, load the HAR, then send another request through a fresh
    // proxy session — but writing to the SAME HAR path.
    localRecorder = new HarRecorder(tmpDir);
    recorder = localRecorder;
    await localRecorder.loadFromFile(originalPath);
    expect(localRecorder.getEntries()).toHaveLength(1);
    expect(localRecorder.getCurrentPath()).toBe(originalPath);

    proxy = await startServer({
      port: 0,
      upstreamTarget: upstream.origin,
      onEntry: (e) => localRecorder.appendEntry(e),
    });
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [] }),
    }).then((r) => r.text());
    await localRecorder.drain();

    // One file on disk, two entries inside.
    const files = (await readdir(tmpDir)).filter((f) => f.endsWith(".har"));
    expect(files).toHaveLength(1);
    expect(localRecorder.getEntries()).toHaveLength(2);
  });
});

interface StreamSummary {
  kinds: string[];
  method?: string;
  url?: string;
  responseStatus?: number;
  assembledBody?: unknown;
}

function summarizeStream(events: ProxyEvent[]): StreamSummary {
  const summary: StreamSummary = { kinds: [] };
  for (const ev of events) {
    summary.kinds.push(ev.kind);
    if (ev.kind === "request_headers") {
      summary.method = ev.method;
      summary.url = ev.url;
    } else if (ev.kind === "response_headers") {
      summary.responseStatus = ev.status;
    } else if (ev.kind === "response_complete") {
      summary.assembledBody = ev.body;
    }
  }
  // The kinds list reflects ordering; live & replay both produce
  // request_headers, request_body, response_headers, sse_event×N,
  // response_complete, response_done. The N may differ (live emits one
  // per network chunk, replay emits one per text block) — divergence is
  // accepted, so collapse consecutive sse_event kinds to "sse_event*"
  // before comparison.
  summary.kinds = collapseConsecutive(summary.kinds, "sse_event");
  return summary;
}

function collapseConsecutive(arr: string[], target: string): string[] {
  const out: string[] = [];
  for (const k of arr) {
    if (k === target && out[out.length - 1] === `${target}*`) continue;
    out.push(k === target ? `${target}*` : k);
  }
  return out;
}
