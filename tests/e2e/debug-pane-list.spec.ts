// End-to-end verification for the topology slice.
//
// Drives the packaged app against an isolated tmux server. Asserts that
// `/debug/tmux-control` reflects every `tmux split-window` / topology event
// without a refresh, with the same testid surface every renderer in the
// app will eventually consume.
//
// Counts are asserted as deltas, not absolutes. The Electron-spawned
// `tmux -CC` may create its own attaching session in addition to the
// fixture's bootstrap, so the seed pane count is environment-dependent;
// only changes around explicit operations are deterministic.

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
const TOPOLOGY_TIMEOUT_MS = 3_000;

test.describe("/debug/tmux-control reflects live topology", () => {
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

  test("reflects a new pane within one event tick of split-window", async () => {
    const { window } = appHandle;

    await expect(window.locator("[data-testid=control-status]")).toHaveText(
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );

    const countLocator = window.locator("[data-testid=topology-pane-count]");
    await expect(countLocator).not.toHaveText("0", {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });

    // Settle: the tracker re-lists on every topology event, so we wait a
    // beat for the seed list-panes to land before snapshotting.
    await window.waitForTimeout(150);
    const beforeCount = Number(await countLocator.textContent());
    const beforeIds = new Set(
      await window
        .locator("[data-pane-row]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-pane-row") ?? ""),
        ),
    );

    execSync(`tmux -L ${server.socket} split-window -t bootstrap`, {
      stdio: "ignore",
    });

    // Global pane count goes up by exactly 1 — the new pane in bootstrap.
    await expect(countLocator).toHaveText(String(beforeCount + 1), {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });

    const afterIds = await window
      .locator("[data-pane-row]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-pane-row") ?? ""),
      );
    const newIds = afterIds.filter((id) => !beforeIds.has(id));
    expect(newIds).toHaveLength(1);
    const newId = newIds[0];
    expect(newId.startsWith("%")).toBe(true);

    // The new row's cmd cell carries content from the subscription (or the
    // seed list-panes), not the empty placeholder.
    const cmdCell = window.locator(`[data-testid="pane-row-${newId}-cmd"]`);
    await expect(cmdCell).toBeVisible();
    const cmdText = (await cmdCell.textContent())?.trim() ?? "";
    expect(cmdText).not.toBe("—");
    expect(cmdText.length).toBeGreaterThan(0);
  });

  test("removes a pane row within one event tick of kill-window", async () => {
    const { window } = appHandle;

    await expect(window.locator("[data-testid=control-status]")).toHaveText(
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );

    const countLocator = window.locator("[data-testid=topology-pane-count]");
    await expect(countLocator).not.toHaveText("0", {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });
    await window.waitForTimeout(150);
    const before = Number(await countLocator.textContent());

    // Add a second window in bootstrap, then kill it. We use new-window
    // (not new-session) so the pane lives under the bootstrap session and
    // surviving session/pane cleanup is automatic.
    execSync(`tmux -L ${server.socket} new-window -t bootstrap`, {
      stdio: "ignore",
    });
    await expect(countLocator).toHaveText(String(before + 1), {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });

    execSync(`tmux -L ${server.socket} kill-window -t bootstrap:1`, {
      stdio: "ignore",
    });
    await expect(countLocator).toHaveText(String(before), {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });
  });
});
