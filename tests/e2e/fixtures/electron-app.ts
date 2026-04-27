// [LAW:single-enforcer] All e2e tests launch the packaged Electron build
// through this fixture. The packaged path keeps the e2e environment as
// close to production as possible — no Vite dev server, no hot-reload —
// while still letting the test inject env vars (notably PROMPTCTL_TMUX_SOCKET)
// to point the singleton TmuxControlConnection at an isolated tmux server.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { assertSafeToDelete } from "./safe-delete";

export interface ElectronAppHandle {
  app: ElectronApplication;
  window: Page;
  close(): Promise<void>;
}

export interface LaunchOptions {
  socket: string;
  /**
   * Initial route to land on when the app boots. Written into
   * ~/.promptctl/settings.json under the isolated HOME so RouteRestorer
   * navigates here on first paint, instead of racing test-side hash mutation.
   */
  initialRoute: string;
  /** Optional extra env. Defaults: nothing beyond the socket. */
  env?: Record<string, string | undefined>;
}

export async function launchElectronApp(
  options: LaunchOptions,
): Promise<ElectronAppHandle> {
  const executablePath = resolvePackagedBinary();
  if (!existsSync(executablePath)) {
    throw new Error(
      [
        `Packaged Electron build not found at ${executablePath}.`,
        `Run \`npm run package\` once before \`npm run test:e2e\`.`,
        `(Building inside Playwright globalSetup is intentionally avoided —`,
        ` electron-forge package is slow enough that we let CI/dev gate it.)`,
      ].join("\n"),
    );
  }

  // [LAW:locality-or-seam] Isolation boundary: a fresh HOME points the app at
  // an empty `~/.promptctl/` (settings/commands/recordings/etc are all
  // homedir-relative) AND avoids the developer's running promptctl single-
  // instance lock (Electron scopes its lock to the user-data-dir, which is
  // homedir-derived). Without this, every e2e launch races the user's app.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "promptctl-e2e-home-"));
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), "promptctl-e2e-userdata-"),
  );

  // [LAW:dataflow-not-control-flow] Pre-seed the route via the same settings
  // file the app would persist itself. RouteRestorer in App.tsx loads
  // settings.lastRoute and navigates to it on cold start, so this seed is the
  // single source of truth for "where does the test land?" — no hash-race,
  // no test-side navigation mutation.
  const promptctlDir = path.join(fakeHome, ".promptctl");
  mkdirSync(promptctlDir, { recursive: true });
  writeFileSync(
    path.join(promptctlDir, "settings.json"),
    JSON.stringify({ lastRoute: options.initialRoute }),
    "utf-8",
  );

  const env: Record<string, string> = {
    ...stripUndefined(process.env as Record<string, string | undefined>),
    ...stripUndefined(options.env ?? {}),
    HOME: fakeHome,
    PROMPTCTL_TMUX_SOCKET: options.socket,
  };

  const app = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${userDataDir}`,
      // [LAW:locality-or-seam] Bypass the OS keychain for cookie-encryption
      // initialization. Without this flag, every e2e launch of the
      // EnableCookieEncryption-fused build pops a macOS "Keychain Not Found"
      // dialog because the isolated user-data-dir has no prior keychain
      // entry. --use-mock-keychain is a Chromium-supplied test switch that
      // routes safeStorage through an in-memory backend.
      "--use-mock-keychain",
      // Belt-and-suspenders: --password-store=basic forces Electron's own
      // password backend to a non-keychain implementation on platforms
      // where Chromium's mock-keychain alone isn't sufficient.
      "--password-store=basic",
    ],
    env,
  });
  const window = await app.firstWindow();

  return {
    app,
    window,
    async close(): Promise<void> {
      await app.close();
      // [LAW:no-defensive-null-guards] The assertion is at a destructive
      // boundary — if it ever throws, a bug in the fixture is about to
      // delete the wrong path, and the test SHOULD fail loudly. Filesystem
      // failures (EBUSY, EPERM, EIO) also propagate: they signal that the
      // process is leaking file handles or that a test left state we can't
      // clean. Either case is worth a loud failure, not a silent leak.
      assertSafeToDelete("fakeHome", fakeHome);
      assertSafeToDelete("userDataDir", userDataDir);
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function resolvePackagedBinary(): string {
  // Forge's default packager output: out/<productName>-<platform>-<arch>/<binary>
  // productName is "promptctl" per package.json. The binary name and path
  // inside the bundle differs by platform.
  const root = path.resolve(__dirname, "..", "..", "..");
  const arch = process.arch;
  const platform = process.platform;

  if (platform === "darwin") {
    return path.join(
      root,
      "out",
      `promptctl-darwin-${arch}`,
      "promptctl.app",
      "Contents",
      "MacOS",
      "promptctl",
    );
  }
  if (platform === "linux") {
    return path.join(root, "out", `promptctl-linux-${arch}`, "promptctl");
  }
  if (platform === "win32") {
    return path.join(root, "out", `promptctl-win32-${arch}`, "promptctl.exe");
  }
  throw new Error(`Unsupported platform for e2e tests: ${platform}`);
}

function stripUndefined(
  src: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
