// [LAW:single-enforcer] All restart triggers funnel through one debounced timer.
// [LAW:dataflow-not-control-flow] watcher emits change events unconditionally;
// the data (filename + restart-set membership) decides whether a restart fires.
//
// Why this exists: @electron-forge/plugin-vite (>=7.11) leaves main-process
// hot-restart as a TODO. Forge's CLI does honour `rs<Enter>` on its stdin
// (see node_modules/@electron-forge/core/dist/api/start.js: the `data` listener
// matches `rs` and respawns the Electron child). This module watches the built
// main/preload bundles and triggers that same `rs` mechanism.

import { mkdirSync, watch, type FSWatcher } from "node:fs";

export interface HotRestartOptions {
  buildDir: string;
  restartFiles: Set<string>;
  debounceMs: number;
  triggerRestart: (changedFiles: string[]) => void;
  log: (message: string) => void;
}

export interface HotRestartHandle {
  stop: () => void;
}

export function startHotRestart(opts: HotRestartOptions): HotRestartHandle {
  mkdirSync(opts.buildDir, { recursive: true });

  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  let stopped = false;

  const watcher: FSWatcher = watch(
    opts.buildDir,
    { recursive: false },
    (_event, filename) => {
      if (stopped) return;
      if (!filename || !opts.restartFiles.has(filename)) return;
      pending.add(filename);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const files = Array.from(pending).sort();
        pending.clear();
        opts.log(`${files.join(", ")} changed → restarting Electron main process`);
        opts.triggerRestart(files);
      }, opts.debounceMs);
    },
  );

  return {
    stop: () => {
      stopped = true;
      watcher.close();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
