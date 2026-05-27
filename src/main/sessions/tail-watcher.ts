// [LAW:single-enforcer] Sole producer of "session:tail" broadcasts.
// One fs.watch per running launch's sessionFilePath, alive for as long
// as the launch is running and has a path. When the file's on-disk
// size grows past the last observed size, broadcast a tail event so
// the renderer can reload the active session if it matches.
//
// [LAW:dataflow-not-control-flow] One pipeline per launch: subscribe
// → open file watcher → debounce → poll size → broadcast-if-grew.
// The variability is which launch, which file, and what size; the
// pipeline is fixed. The watcher does NOT consult "is this file
// currently being edited" — it broadcasts unconditionally and lets
// the renderer filter on its selected session. Decoupling the
// producer from the consumer keeps both ends simple.
//
// [LAW:one-source-of-truth] The launch registry is the authority on
// which files are live; the file size is the authority on whether
// anything changed. The watcher holds only the last-observed size per
// file — derived state, recomputed from the registry on every event.
//
// Self-save protection: when the editor force-saves over a live file
// (the only path that writes to a tailed file), the file shrinks. The
// "size grew" guard skips that case. The next real append re-arms
// the broadcast.

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
} from "../../shared/types";

export interface SessionTailEvent {
  readonly filePath: string;
  readonly size: number;
}

export type TailBroadcast = (event: SessionTailEvent) => void;
export type WatchFileFn = (
  filePath: string,
  onChange: () => void,
) => FileWatcher;
export interface FileWatcher {
  close(): void;
}
export type GetSizeFn = (filePath: string) => Promise<number | null>;

// Subset of LaunchRegistry the tail watcher needs. Same shape as the
// session-watcher's facade so a future test rig can satisfy both with
// one stub. [LAW:locality-or-seam]
export interface TailRegistryFacade {
  list(): readonly Launch[];
  on(handler: (event: LaunchEvent) => void): () => void;
}

export interface SessionTailWatcherOptions {
  readonly registry: TailRegistryFacade;
  readonly broadcast: TailBroadcast;
  readonly watchFile?: WatchFileFn;
  readonly getSize?: GetSizeFn;
  // Coalesce bursts of 'change' events. fs.watch can emit multiple
  // events per write on macOS; reading size for each is wasted work
  // and produces redundant broadcasts. Default 100ms is below user-
  // perceptible reaction time.
  readonly debounceMs?: number;
}

interface PerLaunchState {
  readonly filePath: string;
  readonly watcher: FileWatcher;
  lastSize: number;
  pending: ReturnType<typeof setTimeout> | null;
}

export class SessionTailWatcher {
  private readonly registry: TailRegistryFacade;
  private readonly broadcast: TailBroadcast;
  private readonly watchFile: WatchFileFn;
  private readonly getSize: GetSizeFn;
  private readonly debounceMs: number;

  // Per-launch state; rekeyed by launchId because the same launch's
  // sessionFilePath cannot change while the launch is running (the
  // registry's attach() is one-shot on a null field), but a launch
  // exiting and being replaced by a new launch in the same cwd would
  // produce a new launchId — distinct entry, distinct fs.watch.
  private readonly active = new Map<LaunchId, PerLaunchState>();

  private offRegistry: (() => void) | null = null;

  constructor(options: SessionTailWatcherOptions) {
    this.registry = options.registry;
    this.broadcast = options.broadcast;
    this.watchFile = options.watchFile ?? defaultWatchFile;
    this.getSize = options.getSize ?? defaultGetSize;
    this.debounceMs = options.debounceMs ?? 100;
  }

  start(): void {
    if (this.offRegistry !== null) return;
    this.offRegistry = this.registry.on((event) => {
      this.reconcile(event.launch);
    });
    for (const launch of this.registry.list()) {
      this.reconcile(launch);
    }
  }

  stop(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const s of this.active.values()) {
      if (s.pending) clearTimeout(s.pending);
      s.watcher.close();
    }
    this.active.clear();
  }

  private reconcile(launch: Launch): void {
    const wantsWatch = isTailable(launch);
    const current = this.active.get(launch.launchId);
    if (wantsWatch && !current) {
      this.beginWatch(launch);
    } else if (!wantsWatch && current) {
      this.endWatch(launch.launchId);
    }
  }

  private beginWatch(launch: Launch): void {
    // Narrow safely — isTailable guards the type for callers, but
    // beginWatch is private and we can re-narrow without ceremony.
    if (launch.status !== "running") return;
    if (launch.sessionFilePath === null) return;
    const filePath = launch.sessionFilePath;
    const state: PerLaunchState = {
      filePath,
      watcher: this.watchFile(filePath, () => {
        this.scheduleProbe(launch.launchId);
      }),
      lastSize: 0,
      pending: null,
    };
    this.active.set(launch.launchId, state);
    // Seed the baseline so we don't broadcast on the very first event
    // when the file already had content (recovery / late attach).
    void this.probeBaseline(launch.launchId, filePath);
  }

  private endWatch(launchId: LaunchId): void {
    const s = this.active.get(launchId);
    if (!s) return;
    if (s.pending) clearTimeout(s.pending);
    s.watcher.close();
    this.active.delete(launchId);
  }

  private async probeBaseline(
    launchId: LaunchId,
    filePath: string,
  ): Promise<void> {
    const size = await this.getSize(filePath);
    if (size === null) return;
    const s = this.active.get(launchId);
    if (!s) return;
    if (s.filePath !== filePath) return;
    s.lastSize = size;
  }

  private scheduleProbe(launchId: LaunchId): void {
    const s = this.active.get(launchId);
    if (!s) return;
    if (s.pending) return; // already coalescing this burst
    s.pending = setTimeout(() => {
      const current = this.active.get(launchId);
      if (current) current.pending = null;
      void this.probe(launchId);
    }, this.debounceMs);
    s.pending.unref?.();
  }

  private async probe(launchId: LaunchId): Promise<void> {
    const s = this.active.get(launchId);
    if (!s) return;
    const size = await this.getSize(s.filePath);
    if (size === null) return;
    // Re-fetch state — could have been torn down during the await.
    const cur = this.active.get(launchId);
    if (!cur || cur.filePath !== s.filePath) return;
    if (size <= cur.lastSize) {
      // Shrunk (force-save truncate) or no growth (spurious event).
      // Update lastSize either way so the next real append broadcasts.
      cur.lastSize = size;
      return;
    }
    cur.lastSize = size;
    this.broadcast({ filePath: s.filePath, size });
  }
}

function isTailable(launch: Launch): boolean {
  if (launch.status !== "running") return false;
  return launch.sessionFilePath !== null;
}

const defaultWatchFile: WatchFileFn = (filePath, onChange) => {
  let inner: FSWatcher | null = null;
  let closed = false;
  const tryAttach = (): void => {
    if (closed || inner) return;
    try {
      inner = watch(filePath, () => onChange());
      inner.on("error", () => {
        inner?.close();
        inner = null;
      });
    } catch {
      inner = null;
    }
  };
  tryAttach();
  // The file is created post-attach in the common case (registry
  // attaches sessionFilePath as soon as it appears, but we may race
  // an attach event vs the file being closed for write). A modest
  // retry covers the gap without busy-waiting.
  const retry = setInterval(() => {
    if (closed || inner) return;
    tryAttach();
  }, 500);
  retry.unref?.();
  return {
    close(): void {
      closed = true;
      clearInterval(retry);
      inner?.close();
      inner = null;
    },
  };
};

const defaultGetSize: GetSizeFn = async (filePath) => {
  const s = await stat(filePath).catch(() => null);
  if (!s || !s.isFile()) return null;
  return s.size;
};
