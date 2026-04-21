// @vitest-environment node
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// `os.homedir()` on POSIX honors $HOME, and deep-link-server.ts reads the
// homedir at module-load time. We set HOME, then reset the module graph so
// the fresh import sees the tmp home.
let tmpHome: string;
let server: Server | null = null;

// Used when a test doesn't exercise the handler; an explicit named function
// satisfies no-empty-function without disabling the rule.
function noop(): void {
  return;
}

async function postJson(
  port: number,
  urlPath: string,
  body: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), "deep-link-test-"));
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(async () => {
  if (server) {
    const { stopDeepLinkServer } = await import("./deep-link-server");
    await stopDeepLinkServer(server);
    server = null;
  }
  await rm(tmpHome, { recursive: true, force: true });
});

describe("startDeepLinkServer", () => {
  it("writes the chosen port to ~/.promptctl/deep-link-port", async () => {
    const { startDeepLinkServer } = await import("./deep-link-server");
    server = await startDeepLinkServer(noop);
    const portFile = path.join(tmpHome, ".promptctl", "deep-link-port");
    const port = (await readFile(portFile, "utf-8")).trim();
    expect(Number(port)).toBeGreaterThan(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    expect(String(addr.port)).toBe(port);
  });

  it("invokes the handler with the posted url and responds 200", async () => {
    const { startDeepLinkServer } = await import("./deep-link-server");
    const handler = vi.fn();
    server = await startDeepLinkServer(handler);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const url = "promptctl://open?provider=claude&sessionId=abc-123";
    const res = await postJson(
      addr.port,
      "/open",
      JSON.stringify({ url }),
    );

    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
    expect(handler).toHaveBeenCalledWith(url);
  });

  it("returns 404 for non-/open paths", async () => {
    const { startDeepLinkServer } = await import("./deep-link-server");
    const handler = vi.fn();
    server = await startDeepLinkServer(handler);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const res = await postJson(addr.port, "/other", "{}");
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 when the body isn't valid JSON", async () => {
    const { startDeepLinkServer } = await import("./deep-link-server");
    const handler = vi.fn();
    server = await startDeepLinkServer(handler);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const res = await postJson(addr.port, "/open", "not json at all");
    expect(res.status).toBe(400);
    expect(res.text).toBe("bad json");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload is missing url", async () => {
    const { startDeepLinkServer } = await import("./deep-link-server");
    const handler = vi.fn();
    server = await startDeepLinkServer(handler);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const res = await postJson(addr.port, "/open", JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(res.text).toBe("missing url");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("stopDeepLinkServer", () => {
  it("removes the port file and closes the socket", async () => {
    const { startDeepLinkServer, stopDeepLinkServer } = await import(
      "./deep-link-server"
    );
    server = await startDeepLinkServer(noop);
    const portFile = path.join(tmpHome, ".promptctl", "deep-link-port");

    // Port file exists
    await access(portFile);

    await stopDeepLinkServer(server);
    server = null;

    // Port file removed
    await expect(access(portFile)).rejects.toThrow();
  });
});
