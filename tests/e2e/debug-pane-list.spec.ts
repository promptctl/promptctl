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

// Pin the promptctl-owned session name so the test can target it directly.
// In production this is derived from the install path; the env var override
// exists for exactly this reason.
const OWNED_SESSION = "promptctl-e2e-topo";

test.describe("/debug/tmux-control reflects live topology", () => {
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

    execSync(`tmux -L ${server.socket} split-window -t ${OWNED_SESSION}`, {
      stdio: "ignore",
    });

    // Global pane count goes up by exactly 1 — the new pane in our session.
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

  test("ignores panes in sessions outside the promptctl-owned one", async () => {
    const { window } = appHandle;

    await expect(window.locator("[data-testid=control-status]")).toHaveText(
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );

    const countLocator = window.locator("[data-testid=topology-pane-count]");
    await window.waitForTimeout(150);
    const before = Number(await countLocator.textContent());

    // Pre-existing fixture session "bootstrap" + add another window in it.
    // None of these panes belong to the owned session, so the count must
    // not change.
    execSync(`tmux -L ${server.socket} split-window -t bootstrap`, {
      stdio: "ignore",
    });
    execSync(`tmux -L ${server.socket} new-window -t bootstrap`, {
      stdio: "ignore",
    });

    // Give the tracker a beat — if the filter were broken, the count would
    // jump by 2 within ~50ms. We poll for that for 800ms; if it never
    // happens, the filter is working.
    await window.waitForTimeout(800);
    const after = Number(await countLocator.textContent());
    expect(after).toBe(before);
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

    // Add a second window in the owned session, then kill it. Using
    // new-window (not new-session) keeps the new pane under the owned
    // session so the topology filter sees it.
    execSync(`tmux -L ${server.socket} new-window -t ${OWNED_SESSION}`, {
      stdio: "ignore",
    });
    await expect(countLocator).toHaveText(String(before + 1), {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });

    execSync(`tmux -L ${server.socket} kill-window -t ${OWNED_SESSION}:1`, {
      stdio: "ignore",
    });
    await expect(countLocator).toHaveText(String(before), {
      timeout: TOPOLOGY_TIMEOUT_MS,
    });
  });
});
