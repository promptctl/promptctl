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

  test("status transitions ready → no-sessions → ready around a kill+restart", async () => {
    const { window } = appHandle;

    const status = window.locator("[data-testid=control-status]");

    // 1. Connection reaches ready against the bootstrap session the fixture
    //    created. Discovery enumerates it and spawns a client.
    await expect(status).toHaveText("ready", { timeout: READY_TIMEOUT_MS });

    // 2. Kill the server. Every client's transport drops and the mesh
    //    empties — status transitions to the honest "no-sessions" state
    //    (not "closed": the connection itself isn't closed, the mesh is
    //    just empty until tmux comes back).
    server.killServer();

    await expect(status).toHaveText("no-sessions", {
      timeout: CLOSED_TIMEOUT_MS,
    });

    // 3. Bring the server back with a fresh session. The periodic reconcile
    //    re-enumerates, spawns a client, and the mesh transitions to ready.
    server.newSession("recovery");

    await expect(status).toHaveText("ready", {
      timeout: RECONNECT_TIMEOUT_MS,
    });
  });
});
