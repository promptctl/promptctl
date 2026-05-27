// [LAW:single-enforcer] Sole producer of LaunchRunning.sessionFilePath.
// Watches ~/.claude/projects/<encoded(cwd)>/ for each running Claude
// launch with no sessionFilePath yet, latches the first .jsonl whose
// mtime is at or past launch.startedAt, and writes it back via
// registry.attach. Nobody else fills this field — if a future provider
// (Codex, Gemini) starts emitting session files, the dispatch lives
// here, not in the registry.
//
// [LAW:dataflow-not-control-flow] One pipeline per launch: subscribe →
// scan-then-watch → match-first-jsonl → attach → unsubscribe. The
// variability is which launch and which directory; the pipeline is
// fixed. No "is this a special case" branches in the body.
//
// [LAW:one-source-of-truth] Reads launch rows from the LaunchRegistry,
// writes back through the same registry. Holds no parallel cache.

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  Launch,
  LaunchEvent,
  LaunchId,
  ToolLaunchKind,
} from "../../shared/types";

// Claude encodes a project cwd into a directory name under
// ~/.claude/projects/ by replacing every "/" and "." with "-". Verified
// against the live machine layout: "/Users/bmf/code/promptctl" →
// "-Users-bmf-code-promptctl"; "/Users/bmf/code/promptctl/.claude" →
// "-Users-bmf-code-promptctl--claude" (the "." between segments becomes
// a second "-", producing the doubled dash). The encoding is one-way —
// we can't recover the cwd from the dir name unambiguously, but we
// don't need to: launches carry their cwd, so we encode forward to
// derive the dir we should watch.
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// Which tool kinds this watcher handles. Today: Claude only. Codex /
// Gemini emit no on-disk session JSONL we can correlate, so they never
// produce a sessionFilePath.
const SUPPORTED: ReadonlySet<ToolLaunchKind> = new Set(["claude"]);

export interface LaunchSessionWatcherOptions {
  // The launch registry that owns the rows we write back to. The
  // watcher only reads via the event subscription + lookup; mutations
  // go through registry.attach exclusively.
  readonly registry: LaunchSessionRegistryFacade;
  // Root under which Claude writes per-project session directories.
  // Defaults to ~/.claude/projects. Injectable so tests can point at a
  // tempdir.
  readonly projectsRoot: string;
  // Override file-watch factory for tests. Production wires it to
  // node's fs.watch. The returned object must expose `close()` and
  // invoke the listener with the basename of any file event in the
  // watched directory.
  readonly watchDir?: WatchDirFn;
}

export type WatchDirFn = (
  dir: string,
  onChange: (filename: string) => void,
) => DirWatcher;

export interface DirWatcher {
  close(): void;
}

// Subset of LaunchRegistry the watcher needs. Narrow so unit tests can
// stub without dragging in persistence.
export interface LaunchSessionRegistryFacade {
  list(): readonly Launch[];
  on(handler: (event: LaunchEvent) => void): () => void;
  attach(
    launchId: LaunchId,
    fields: { readonly sessionFilePath: string },
  ): Launch | null;
}

export class LaunchSessionWatcher {
  private readonly registry: LaunchSessionRegistryFacade;
  private readonly projectsRoot: string;
  private readonly watchDir: WatchDirFn;

  // One per launch we're currently watching. The pipeline detaches the
  // entry the moment we attach a sessionFilePath (or the launch exits)
  // — leaving an entry here for an already-attached launch would be a
  // resource leak and a [LAW:no-defensive-null-guards] violation in
  // waiting (the next file event would re-check status, find nothing
  // to do, and silently return).
  private readonly active = new Map<LaunchId, DirWatcher>();

  // Subscription handle from the registry. null until start() runs;
  // back to null after stop().
  private offRegistry: (() => void) | null = null;

  constructor(options: LaunchSessionWatcherOptions) {
    this.registry = options.registry;
    this.projectsRoot = options.projectsRoot;
    this.watchDir = options.watchDir ?? defaultWatchDir;
  }

  start(): void {
    if (this.offRegistry !== null) return;
    this.offRegistry = this.registry.on((event) => {
      this.reconcile(event.launch);
    });
    // Catch up to existing rows (recovery may have re-bound launches
    // before the watcher started; the events for those rows already
    // fired). [LAW:dataflow-not-control-flow] Same code path as event
    // delivery — we just play the current state through it.
    for (const launch of this.registry.list()) {
      this.reconcile(launch);
    }
  }

  stop(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const w of this.active.values()) w.close();
    this.active.clear();
  }

  // Single decision point: should this launch be watched?  If yes and
  // we're not watching, attach. If no and we are, detach. Reads the
  // launch's *current* state — race-safe because the registry is the
  // canonical source.
  private reconcile(launch: Launch): void {
    const needsWatch = wantsWatch(launch);
    const watching = this.active.has(launch.launchId);
    if (needsWatch && !watching) {
      this.beginWatch(launch);
    } else if (!needsWatch && watching) {
      this.endWatch(launch.launchId);
    }
  }

  private beginWatch(launch: Launch): void {
    const dir = path.join(
      this.projectsRoot,
      encodeClaudeProjectDirName(launch.cwd),
    );
    // Scan the dir once for an already-present qualifying file (the
    // file can land between launch start and our first event), then
    // attach the directory watcher for anything that appears after.
    // [LAW:dataflow-not-control-flow] The scan and the watch feed the
    // same matcher; no branching on "did we find it on disk vs. via
    // event".
    const watcher = this.watchDir(dir, (filename) => {
      void this.tryClaim(launch.launchId, dir, filename);
    });
    this.active.set(launch.launchId, watcher);
    void this.scanOnce(launch.launchId, dir);
  }

  private endWatch(launchId: LaunchId): void {
    const w = this.active.get(launchId);
    if (!w) return;
    w.close();
    this.active.delete(launchId);
  }

  private async scanOnce(launchId: LaunchId, dir: string): Promise<void> {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const claimed = await this.tryClaim(launchId, dir, name);
      if (claimed) return;
    }
  }

  // Atomic per-file check: does this file qualify, and is the launch
  // still in the "unbound" state we expect? Re-reads the launch row
  // each call — the registry may have attached a path from a sibling
  // event since the previous tick. Returns true if we attached, so the
  // initial scan can stop iterating.
  private async tryClaim(
    launchId: LaunchId,
    dir: string,
    filename: string,
  ): Promise<boolean> {
    if (!filename.endsWith(".jsonl")) return false;
    // Re-read the row. wantsWatch covers all the gating: launchKind,
    // status, sessionFilePath==null. If any changed since the watcher
    // started, drop the watch and bail.
    const current = this.registry.list().find((l) => l.launchId === launchId);
    if (!current) {
      this.endWatch(launchId);
      return false;
    }
    if (!wantsWatch(current)) {
      this.endWatch(launchId);
      return false;
    }
    const fullPath = path.join(dir, filename);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) return false;
    // Mtime must be at or after launch start. Older files belong to
    // prior runs in the same cwd. We use floor(ms) on both sides
    // because some filesystems quantize mtime to whole seconds, and we
    // don't want to drop a file that lands within the same second as
    // launch.startedAt.
    const mtimeMs = Math.floor(fileStat.mtimeMs);
    const startMs = Math.floor(current.startedAt);
    if (mtimeMs < startMs) return false;
    // Attach. Registry guards against re-attach: if sessionFilePath is
    // already set, attach is a no-op and we still tear down here. If
    // the launch exited between our list() and attach(), attach
    // returns null and we also tear down — same outcome.
    this.registry.attach(launchId, { sessionFilePath: fullPath });
    this.endWatch(launchId);
    return true;
  }
}

function wantsWatch(launch: Launch): boolean {
  if (!SUPPORTED.has(launch.toolKind)) return false;
  if (launch.status !== "running") return false;
  return launch.sessionFilePath === null;
}

const defaultWatchDir: WatchDirFn = (dir, onChange) => {
  // fs.watch can throw if the dir doesn't exist yet — we'd rather
  // observe creation than require the dir to pre-exist, but Claude
  // creates the directory the moment it writes its first session file,
  // and our scan-on-start catches a file that landed before the
  // watcher attached. If the dir genuinely doesn't exist, fs.watch
  // throws ENOENT — we wrap with a recoverable shim that no-ops until
  // the dir appears, then upgrades to a real watcher on the next tick.
  // Keeping that complexity inside the default implementation keeps
  // the watcher core agnostic of which OS we're on.
  let inner: FSWatcher | null = null;
  let closed = false;

  const tryAttach = (): void => {
    if (closed || inner) return;
    try {
      inner = watch(dir, (_eventType, filename) => {
        if (typeof filename === "string" && filename.length > 0) {
          onChange(filename);
        }
      });
      inner.on("error", () => {
        // Drop the watcher and try again later — most often this is a
        // transient EACCES while Claude is replacing the dir. The next
        // scan tick will re-attach.
        inner?.close();
        inner = null;
      });
    } catch {
      // Dir not present yet. We'll retry on the next interval tick.
      inner = null;
    }
  };

  // Optimistic first attach; if it fails, the interval below catches
  // up. Interval is generous — the directory only fails to exist for
  // brand-new cwds that have never been a Claude project. Once the
  // directory is created we get a real watcher and stop polling.
  tryAttach();
  const retry = setInterval(() => {
    if (closed || inner) return;
    tryAttach();
  }, 500);
  // Don't pin the event loop alive purely on this polling timer —
  // letting it block app shutdown would be a [LAW:no-defensive-null-
  // guards] cousin: a retry mechanism keeping the process up after the
  // launch is dead. unref() releases the hold.
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
