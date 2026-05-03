// End-to-end verification for the output byte-stream slice.
//
// Drives the packaged app against an isolated tmux server. Asserts that
// /debug/tmux-control reflects live output for a watched pane: the user
// clicks "watch" on a pane, sends keys to that pane, and the byte-stream
// region contains the sent text within a short window.
//
// The test targets the same data-testid surface the renderer uses —
// `[data-testid=watch-<paneId>]` for the watch button and
// `[data-testid=byte-stream]` for the output region.

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import {
  createTmuxServer,
  type TmuxServerHandle,
} from "./fixtures/tmux-server";
import {
  launchElectronApp,
  type ElectronAppHandle,
} from "./fixtures/electron-app";

const READY_TIMEOUT_MS = 10_000;
const OUTPUT_TIMEOUT_MS = 3_000;

const OWNED_SESSION = "promptctl-e2e-output";

test.describe("/debug/tmux-control byte stream", () => {
  let server: TmuxServerHandle;
  let appHandle: ElectronAppHandle;

  test.beforeEach(async ({}, testInfo) => {
    server = createTmuxServer(testInfo.workerIndex);
    appHandle = await launchElectronApp({
      socket: server.socket,
      initialRoute: "/debug/tmux-control",
      env: { PROMPTCTL_TMUX_SESSION: OWNED_SESSION },
    });
  });

  test.afterEach(async () => {
    await appHandle?.close();
    server?.killServer();
  });

  test("shows live output in the byte stream after clicking watch", async () => {
    const { window } = appHandle;

    // Wait for the connection to be ready.
    await expect(window.locator("[data-testid=control-status]")).toHaveText(
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );

    // Wait for at least one pane to appear.
    const countLocator = window.locator("[data-testid=topology-pane-count]");
    await expect(countLocator).not.toHaveText("0", {
      timeout: READY_TIMEOUT_MS,
    });

    // Find the first pane row and extract its pane ID.
    await window.waitForTimeout(150);
    const paneIds = await window
      .locator("[data-pane-row]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-pane-row") ?? ""),
      );
    expect(paneIds.length).toBeGreaterThanOrEqual(1);
    const paneId = paneIds[0];
    expect(paneId.startsWith("%")).toBe(true);

    // Click the watch button for this pane.
    const watchButton = window.locator(`[data-testid="watch-${paneId}"]`);
    await watchButton.click();

    // The byte-stream region should appear.
    const byteStream = window.locator("[data-testid=byte-stream]");
    await expect(byteStream).toBeVisible({ timeout: OUTPUT_TIMEOUT_MS });

    // The output state should show streaming.
    const stateLocator = window.locator("[data-testid=output-state]");
    await expect(stateLocator).toHaveText("streaming", {
      timeout: OUTPUT_TIMEOUT_MS,
    });

    // Send keys to the pane via tmux.
    const marker = `HELLO_E2E_${Date.now()}`;
    execSync(
      `tmux -L ${server.socket} send-keys -t ${paneId} 'echo ${marker}' Enter`,
    );

    // Assert the byte-stream contains the marker text.
    await expect(byteStream).toContainText(marker, {
      timeout: OUTPUT_TIMEOUT_MS,
    });
  });

  test("watch button toggles to stop and clears the output region", async () => {
    const { window } = appHandle;

    await expect(window.locator("[data-testid=control-status]")).toHaveText(
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );

    const countLocator = window.locator("[data-testid=topology-pane-count]");
    await expect(countLocator).not.toHaveText("0", {
      timeout: READY_TIMEOUT_MS,
    });
    await window.waitForTimeout(150);

    const paneIds = await window
      .locator("[data-pane-row]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-pane-row") ?? ""),
      );
    const paneId = paneIds[0];

    // Click watch — output region appears.
    await window.locator(`[data-testid="watch-${paneId}"]`).click();
    await expect(window.locator("[data-testid=byte-stream]")).toBeVisible({
      timeout: OUTPUT_TIMEOUT_MS,
    });

    // Button should now say "stop".
    const watchButton = window.locator(`[data-testid="watch-${paneId}"]`);
    await expect(watchButton).toHaveText("stop");

    // Click stop — output region disappears.
    await watchButton.click();
    await expect(window.locator("[data-testid=byte-stream]")).not.toBeVisible();
  });
});
