// Entry script for `npm start`.
//
// Spawns electron-forge as a child, bridges stdin both ways (so the user can
// still type `rs` to restart manually), and runs a Vite watcher in this
// process that rebuilds main/preload on source changes — when a rebuild
// completes, writes `rs\n` to forge's stdin to trigger the restart.
//
// Why a wrapper instead of a Forge plugin: Forge's listr2 task pipeline
// blocks subprocess execution from preStart, drops postStart hooks entirely,
// and starves setTimeout from init. Vite's own watch mode goes inert when
// invoked from inside Forge's process. Running outside Forge sidesteps all
// of that.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import {
  DEV_WRAPPER_ENV_VAR,
  DEV_WRAPPER_SENTINEL,
} from "./dev/wrapper-guard";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FORGE_BIN = path.join(
  PROJECT_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-forge.cmd" : "electron-forge",
);
const MAIN_ENTRY = path.join(PROJECT_ROOT, "src", "main", "main.ts");
const PRELOAD_ENTRY = path.join(PROJECT_ROOT, "src", "main", "preload.ts");
const OUT_DIR = path.join(PROJECT_ROOT, ".vite", "build");

if (!existsSync(FORGE_BIN)) {
  console.error(`[dev] electron-forge binary not found at ${FORGE_BIN}`);
  console.error(`[dev] run \`npm install\` first.`);
  process.exit(1);
}

const forge: ChildProcess = spawn(FORGE_BIN, ["start"], {
  cwd: PROJECT_ROOT,
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, [DEV_WRAPPER_ENV_VAR]: DEV_WRAPPER_SENTINEL },
});

if (!forge.stdin) {
  console.error("[dev] failed to attach stdin pipe to electron-forge");
  process.exit(1);
}

// Intentionally NOT bridging stdin → forge.stdin. Doing so breaks Vite's
// chokidar watcher in this process (verified empirically: pipe present →
// Vite never fires writeBundle on rebuild; pipe absent → works correctly).
// Users lose the ability to type `rs<Enter>` manually, but auto-restart
// fires on every save so the manual path is no longer needed.

// Trigger restart by writing `rs\n` to forge's stdin.
const triggerRestart = (file: string) => {
  if (!forge.stdin || !forge.stdin.writable) return;
  process.stdout.write(
    `\n\x1b[36m[hot-restart]\x1b[0m ${file} rebuilt → restarting Electron\n`,
  );
  forge.stdin.write("rs\n", (err) => {
    if (err) {
      process.stderr.write(`[hot-restart] failed to write rs: ${err.message}\n`);
    }
  });
};

// Start a Vite watcher per entry. Each watcher's writeBundle hook fires on
// every successful rebuild — first one is the initial build (skipped), every
// subsequent one is a real source-change rebuild that triggers a restart.
async function startWatcher(entry: string, outFile: string): Promise<void> {
  let buildCount = 0;
  const watcher = await build({
    root: PROJECT_ROOT,
    configFile: false,
    logLevel: "warn",
    clearScreen: false,
    resolve: {
      conditions: ["node"],
      mainFields: ["module", "jsnext:main", "jsnext"],
    },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      target: ["esnext"],
      lib: { entry, formats: ["cjs"], fileName: () => outFile },
      sourcemap: "inline",
      watch: {},
      rollupOptions: { external: ["electron", /^electron\//, /^node:/] },
    },
    plugins: [
      {
        name: "promptctl:hot-restart-trigger",
        writeBundle() {
          buildCount += 1;
          // Skip the first build — that's the watcher's own initial build,
          // which happens just after plugin-vite's. Restarting Electron now
          // would cycle it before the user has even seen it.
          if (buildCount === 1) return;
          triggerRestart(outFile);
        },
      },
    ],
  });
  // Hold reference so the Rollup watcher isn't GC'd.
  activeWatchers.push(watcher);
}

const activeWatchers: unknown[] = [];

// Kick off watchers in parallel; don't block forge startup on them.
Promise.all([
  startWatcher(MAIN_ENTRY, "main.js"),
  startWatcher(PRELOAD_ENTRY, "preload.js"),
]).catch((err) => {
  process.stderr.write(`[hot-restart] watcher setup failed: ${err}\n`);
});

const forwardSignal = (sig: NodeJS.Signals) => () => {
  if (!forge.killed) forge.kill(sig);
};
process.on("SIGINT", forwardSignal("SIGINT"));
process.on("SIGTERM", forwardSignal("SIGTERM"));
process.on("SIGHUP", forwardSignal("SIGHUP"));

forge.on("exit", (code, signal) => {
  process.stdin.unpipe(forge.stdin!);
  process.stdin.pause();
  process.exit(code ?? (signal ? 1 : 0));
});

forge.on("error", (err) => {
  console.error(`[dev] electron-forge failed to start: ${err.message}`);
  process.exit(1);
});
