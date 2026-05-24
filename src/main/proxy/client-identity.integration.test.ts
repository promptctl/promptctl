// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { execFile, spawn } from "node:child_process";

import { proxyEventBus } from "./events";
import { startServer, type RunningServer } from "./server";
import type { ProxyEvent } from "../../shared/proxy-events";

let proxy: RunningServer | null = null;
let upstream: http.Server | null = null;
let unsubscribe: (() => void) | null = null;

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  if (proxy) {
    await proxy.close();
    proxy = null;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    upstream = null;
  }
});

describe("client identity integration", () => {
  it("stamps a spawned node client's pid onto proxy events", async () => {
    const events: ProxyEvent[] = [];
    unsubscribe = proxyEventBus.subscribe((event) => events.push(event));
    upstream = await startUpstream();
    const addr = upstream.address();
    if (typeof addr !== "object" || addr === null)
      throw new Error("upstream addr");

    proxy = await startServer({
      port: 0,
      upstreamTarget: `http://127.0.0.1:${addr.port}`,
      onEntry: () => undefined,
    });

    const child = spawn(process.execPath, ["-e", childPostScript(proxy.port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("child pid unavailable");
    const childAncestry = await readAncestry(childPid);

    const exit = await waitForExit(child);
    expect(exit.code).toBe(0);
    expect(exit.stderr).toBe("");

    const requestEvent = events.find(
      (event) => event.kind === "request_headers",
    );
    expect(requestEvent).toBeDefined();
    expect(requestEvent?.clientId.startsWith("socket-")).toBe(false);
    expect(
      childAncestry.has(Number(requestEvent?.clientId)),
      `clientId ${requestEvent?.clientId} ancestry ${[...childAncestry].join(",")}`,
    ).toBe(true);
  });
});

async function startUpstream(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) void _;
    const body = JSON.stringify({
      id: "msg_identity",
      type: "message",
      role: "assistant",
      model: "test",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function childPostScript(port: number): string {
  return `
const http = require("node:http");
const body = JSON.stringify({ model: "test", messages: [] });
const agent = new http.Agent({ keepAlive: true });
const req = http.request({
  hostname: "127.0.0.1",
  port: ${port},
  path: "/v1/messages",
  method: "POST",
  agent,
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  },
}, (res) => {
  res.resume();
  res.on("end", () => {
    setTimeout(() => {
      agent.destroy();
      process.exit(res.statusCode === 200 ? 0 : 2);
    }, 750);
  });
});
req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.end(body);
`;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stderr: string;
}> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

async function readAncestry(pid: number): Promise<Set<number>> {
  const ancestry = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < 10; depth += 1) {
    const parent = await readParentPid(current);
    if (parent <= 1) break;
    ancestry.add(parent);
    current = parent;
  }
  return ancestry;
}

function readParentPid(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Number(stdout.trim()));
    });
  });
}
