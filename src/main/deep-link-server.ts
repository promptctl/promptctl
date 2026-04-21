// [LAW:single-enforcer] HTTP loopback transport for deep-link dispatch.
// macOS dev mode cannot reliably route promptctl:// to the running Electron
// (stock Electron.app's bundle id is generic). This module exposes a local
// HTTP endpoint the PostToolUse hook curls into, which calls the same
// handleDeepLink function the URL scheme would.
//
// Writes the listening port to ~/.promptctl/deep-link-port so the hook can
// discover it without env var or hardcoded port coordination.
import http from "node:http";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT_FILE = path.join(os.homedir(), ".promptctl", "deep-link-port");

export function startDeepLinkServer(
  handle: (url: string) => void,
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/open") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { url } = JSON.parse(body) as { url?: string };
          if (typeof url !== "string") {
            res.writeHead(400).end("missing url");
            return;
          }
          console.log(`[deep-link] http /open url=${url}`);
          handle(url);
          res.writeHead(200).end("ok");
        } catch (err) {
          console.log(`[deep-link] http /open parse error: ${err}`);
          res.writeHead(400).end("bad json");
        }
      });
    });

    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server has no address"));
        return;
      }
      try {
        await mkdir(path.dirname(PORT_FILE), { recursive: true });
        await writeFile(PORT_FILE, String(addr.port), "utf-8");
        console.log(
          `[deep-link] http listening on 127.0.0.1:${addr.port} (port file: ${PORT_FILE})`,
        );
        resolve(server);
      } catch (err) {
        reject(err as Error);
      }
    });

    server.on("error", reject);
  });
}

export async function stopDeepLinkServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unlink(PORT_FILE).catch(() => {
    // port file may not exist; nothing to clean up
  });
}
