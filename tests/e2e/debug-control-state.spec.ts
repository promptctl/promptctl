// End-to-end verification for the connection-state slice.
//
// Drives the real packaged app against an isolated tmux server. Asserts that
// `/debug/tmux-control` reflects every server-side state transition without
// a refresh — the single observable acceptance criterion the entire vertical
// slice exists to deliver.

import { test, expect } from "@playwright/test";
import {
  createTmuxServer,
  type TmuxServerHandle,
} from "./fixtures/tmux-server";
import {
  launchElectronApp,
  type ElectronAppHandle,
} from "./fixtures/electron-app";

const READY_TIMEOUT_MS = 10_000;
const CLOSED_TIMEOUT_MS = 3_000;
const RECONNECT_TIMEOUT_MS = 5_000;

test.describe("/debug/tmux-control reflects TmuxControlConnection state", () => {
  let server: TmuxServerHandle;
  let appHandle: ElectronAppHandle;

  test.beforeEach(async ({}, testInfo) => {
    server = createTmuxServer(testInfo.workerIndex);
    appHandle = await launchElectronApp({
      socket: server.socket,
      initialRoute: "/debug/tmux-control",
    });
  });

  test.afterEach(async () => {
    await appHandle?.close();
    server?.killServer();
  });

  test("status transitions ready → closed → ready around a kill+restart", async () => {
    const { window } = appHandle;

    const status = window.locator("[data-testid=control-status]");
    const reason = window.locator("[data-testid=control-reason]");
    const reconnects = window.locator(
      "[data-testid=control-reconnect-attempts]",
    );

    // 1. Connection reaches ready against the bootstrap session.
    await expect(status).toHaveText("ready", { timeout: READY_TIMEOUT_MS });

    // 2. Kill the server. The transport drops; main routes through
    //    handleClientFailure → setStatus("closed") → reconnect-loop, and
    //    forwards the new state on `tmux:control-state`.
    server.killServer();

    await expect(status).toHaveText("closed", { timeout: CLOSED_TIMEOUT_MS });
    // `reason` should carry whatever the transport reported; assert it's
    // non-empty rather than match an exact string (tmux can phrase it
    // differently across platforms / versions).
    await expect(reason).not.toHaveText("—");

    // 3. Bring the server back. The next reconnect probe succeeds and the
    //    panel returns to "ready".
    server.newSession("recovery");

    await expect(status).toHaveText("ready", {
      timeout: RECONNECT_TIMEOUT_MS,
    });

    // Reconnect counter must have incremented at least once across the cycle.
    const attempts = Number(await reconnects.textContent());
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});
