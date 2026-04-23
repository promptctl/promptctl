// [LAW:single-enforcer] All proxy lifecycle (start, stop, replay-from-har)
// is owned here. The IPC handler module calls this surface; main.ts boots it.
// [LAW:one-source-of-truth] Module-scope singleton — there's exactly one
// proxy per app process.
import path from "node:path";
import { homedir } from "node:os";

import type { HarEntry, ProxyStatus } from "../../shared/proxy-events";
import { HarRecorder } from "./har-recorder";
import { replayHarFile } from "./har-replayer";
import { startServer, type RunningServer } from "./server";
import { closeUpstream } from "./upstream";

export interface ProxyStartOptions {
  port: number;
  upstreamTarget: string;
  recordingsDir: string;
}

class ProxyManager {
  private server: RunningServer | null = null;
  private recorder: HarRecorder | null = null;
  private upstreamTarget = "https://api.anthropic.com";
  private recordingsDir = path.join(homedir(), ".promptctl", "proxy-recordings");

  async start(opts: ProxyStartOptions): Promise<ProxyStatus> {
    if (this.server !== null) {
      // Already running — return current status. Idempotent start avoids
      // the awkward "did the user click twice?" edge.
      return this.status();
    }
    this.upstreamTarget = opts.upstreamTarget;
    this.recordingsDir = opts.recordingsDir;
    const recorder = new HarRecorder(opts.recordingsDir);
    this.recorder = recorder;
    this.server = await startServer({
      port: opts.port,
      upstreamTarget: opts.upstreamTarget,
      onEntry: (e: HarEntry) => recorder.appendEntry(e),
    });
    return this.status();
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    if (this.recorder) {
      await this.recorder.drain();
      this.recorder = null;
    }
  }

  // Load entries from a HAR file. The proxy must be running first; loaded
  // entries are seeded into the recorder so subsequent live traffic appends
  // to the same file. Replay also fans events through the bus so the Live
  // tab repaints.
  async loadHar(filePath: string): Promise<ProxyStatus> {
    if (this.server === null || this.recorder === null) {
      throw new Error("Proxy must be running before loadHar");
    }
    await this.recorder.loadFromFile(filePath);
    await replayHarFile(filePath);
    return this.status();
  }

  status(): ProxyStatus {
    return {
      running: this.server !== null,
      port: this.server?.port ?? 0,
      upstreamTarget: this.upstreamTarget,
      recordingPath: this.recorder?.getCurrentPath() ?? null,
      entryCount: this.recorder?.getEntries().length ?? 0,
    };
  }

  // Test/dev hooks.
  isRunning(): boolean {
    return this.server !== null;
  }
}

export const proxyManager = new ProxyManager();

// Process-shutdown hook for the upstream undici Agent. main.ts calls this
// in before-quit alongside proxyManager.stop().
export async function shutdownProxy(): Promise<void> {
  await proxyManager.stop();
  await closeUpstream();
}
