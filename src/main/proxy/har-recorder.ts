// [LAW:single-enforcer] Sole writer of HAR files. The proxy server hands
// completed entries here via the EntrySink callback. We accumulate in memory
// and atomic-rewrite on every entry — simple, crash-safe, fine up to ~20MB.
//
// [LAW:dataflow-not-control-flow] Lazy creation: there's no "recording on/off"
// flag. The presence-or-absence of entries drives the presence-or-absence of
// a file. Adding the first entry triggers the first write; never sooner.
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { HarEntry, HarFile } from "../../shared/proxy-events";

const CREATOR = { name: "promptctl", version: "0.1.0" };

export class HarRecorder {
  private entries: HarEntry[] = [];
  private currentPath: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly recordingsDir: string) {}

  // [LAW:one-source-of-truth] currentPath is the canonical "where we're
  // writing now". Live tab reads it via getCurrentPath() — no second copy.
  getCurrentPath(): string | null {
    return this.currentPath;
  }

  getEntries(): readonly HarEntry[] {
    return this.entries;
  }

  // Called by the proxy server when an entry completes. Lazy-creates the
  // file path on the first call.
  appendEntry(entry: HarEntry): void {
    if (this.currentPath === null) {
      this.currentPath = generateHarPath(this.recordingsDir);
    }
    this.entries.push(entry);
    // Serialize writes through a queue so concurrent appends don't race the
    // tmp-file write/rename pair. Errors propagate but don't block subsequent
    // writes — they're logged and the in-memory state remains authoritative.
    this.writeQueue = this.writeQueue
      .then(() => this.flush())
      .catch((err) => {
        console.error("[har-recorder] write failed:", err);
      });
  }

  // For HAR resume: seed in-memory state and adopt the file path. The next
  // appendEntry() will write the file (now containing both the loaded
  // entries and the new one).
  async loadFromFile(filePath: string): Promise<void> {
    const text = await readFile(filePath, "utf8");
    const har = JSON.parse(text) as HarFile;
    if (har.log?.version !== "1.2") {
      throw new Error(`Unsupported HAR version: ${har.log?.version ?? "?"}`);
    }
    this.entries = har.log.entries.slice();
    this.currentPath = filePath;
  }

  // Forget the current file (used between sessions or when the user explicitly
  // resets). Does not delete the file from disk.
  reset(): void {
    this.entries = [];
    this.currentPath = null;
  }

  // Flush waits for any pending write to settle. Useful in tests and on
  // shutdown.
  async drain(): Promise<void> {
    await this.writeQueue;
  }

  private async flush(): Promise<void> {
    if (this.currentPath === null) return;
    await mkdir(path.dirname(this.currentPath), { recursive: true });
    const har: HarFile = {
      log: {
        version: "1.2",
        creator: CREATOR,
        entries: this.entries,
      },
    };
    const tmpPath = `${this.currentPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(har, null, 2), "utf8");
    await rename(tmpPath, this.currentPath);
  }
}

function generateHarPath(dir: string): string {
  // ISO timestamp with no colons (Windows-friendly) + short random suffix.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `session-${ts}-${suffix}.har`);
}
