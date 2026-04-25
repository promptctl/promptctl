import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import path from "node:path";
import { startHotRestart } from "./scripts/dev/hot-restart";

const config: ForgeConfig = {
  // [LAW:single-enforcer] preStart hooks the main-process hot-restart watcher
  // into Forge's own start lifecycle. Vite already rebuilds .vite/build/main.js
  // on source changes; this watcher sees the rebuild and triggers Forge's
  // existing `rs` restart path via process.stdin (same EventEmitter Forge's
  // own keystroke handler listens on — see node_modules/@electron-forge/core/
  // dist/api/start.js).
  //
  // Because the watcher is part of the config, every `electron-forge start`
  // invocation gets it — there is no path to launch dev without hot-restart.
  hooks: {
    preStart: async () => {
      startHotRestart({
        buildDir: path.join(__dirname, ".vite", "build"),
        restartFiles: new Set(["main.js", "preload.js"]),
        debounceMs: 150,
        triggerRestart: () => {
          process.stdin.emit("data", Buffer.from("rs\n"));
        },
        log: (msg) => {
          process.stderr.write(`\n\x1b[36m[hot-restart]\x1b[0m ${msg}\n`);
        },
      });
    },
  },
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/main/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
