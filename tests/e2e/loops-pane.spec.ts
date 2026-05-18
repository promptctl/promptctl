// End-to-end verification for the Loops tab on @promptctl/pane-terminal
// (77e.1.9 chunk B). Asserts that the production Loops route — not the
// /debug/tmux-control diagnostic surface — mounts the library's
// <PaneTerminal> and that the live byte path works end-to-end through it.
//
// Observation strategy: the renderer DOM is authoritative.
//  - TmuxTree exposes one button per pane via `[data-testid="loops-pane-row-<id>"]`
//    so the test can resolve a pane row by tmux id from `list-panes`.
//  - PaneViewer wraps the library's terminal mount in
//    `[data-testid="loops-pane-terminal"]`; once the user picks a pane, that
//    element renders `<PaneTerminal stream={…}>`, whose XtermSink mounts a
//    `.xterm` element. Visibility of `.xterm` inside the wrapper is the
//    single observable proof Loops is now running on the library.

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
const RENDER_TIMEOUT_MS = 5_000;

const OWNED_SESSION = "promptctl-e2e-loops";

function tmux(socket: string, args: string): string {
  return execSync(`tmux -L ${socket} ${args}`, { encoding: "utf-8" });
}

test.describe("/loops on @promptctl/pane-terminal", () => {
  let server: TmuxServerHandle;
  let appHandle: ElectronAppHandle;
  let rendererErrors: string[];

  test.beforeEach(async ({}, testInfo) => {
    server = createTmuxServer(testInfo.workerIndex);
    appHandle = await launchElectronApp({
      socket: server.socket,
      initialRoute: "/loops",
      env: { PROMPTCTL_TMUX_SESSION: OWNED_SESSION },
    });
    // [LAW:verifiable-goals] pageerror + console.error are part of the gate.
    // The two-Reacts crash that bit chunk A renders nothing visible but fires
    // pageerror — without this any silent renderer failure would be diagnosed
    // as "selector not found" instead of the real cause.
    rendererErrors = [];
    appHandle.window.on("pageerror", (err) => {
      rendererErrors.push(`${err.message}\n${err.stack ?? ""}`);
    });
    appHandle.window.on("console", (msg) => {
      if (msg.type() === "error") {
        rendererErrors.push(`[console.error] ${msg.text()}`);
      }
    });
  });

  test.afterEach(async () => {
    await appHandle?.close();
    server?.killServer();
    expect(
      rendererErrors,
      "Renderer reported uncaught errors during test",
    ).toEqual([]);
  });

  test("selecting a pane in Loops mounts <PaneTerminal> and renders live bytes", async () => {
    const page = appHandle.window;

    // Resolve the owned-session pane id from tmux truth, then wait for that
    // pane's button to appear in the tree. The button's testid uses the same
    // id format (`%N`).
    const paneId = tmux(
      server.socket,
      `list-panes -t ${OWNED_SESSION} -F '#{pane_id}'`,
    ).trim();
    expect(paneId.startsWith("%")).toBe(true);

    const row = page.locator(`[data-testid="loops-pane-row-${paneId}"]`);
    await expect(row).toBeVisible({ timeout: READY_TIMEOUT_MS });

    // Before click: PaneViewer renders the "Select a pane" placeholder, so
    // the terminal wrapper is absent. After click: wrapper appears and the
    // library mounts `.xterm` inside it.
    await row.click();
    const wrapper = page.locator("[data-testid=loops-pane-terminal]");
    await expect(wrapper).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
    await expect(wrapper.locator(".xterm").first()).toBeVisible({
      timeout: RENDER_TIMEOUT_MS,
    });

    // Drive bytes from tmux into the pane. The library's PaneStream
    // subscribes via the singleton TmuxControlConnection's `output` event;
    // those bytes land in xterm-rows.
    const marker = `LOOPS_${Date.now().toString(36)}`;
    tmux(server.socket, `send-keys -t ${paneId} 'cat' Enter`);
    await page.waitForTimeout(200);
    tmux(server.socket, `send-keys -t ${paneId} '${marker}' Enter`);
    await expect(
      wrapper.locator(".xterm-rows").first(),
    ).toContainText(marker, { timeout: RENDER_TIMEOUT_MS });
  });

  test("keystrokes typed into Loops reach tmux through the library", async () => {
    const page = appHandle.window;
    const paneId = tmux(
      server.socket,
      `list-panes -t ${OWNED_SESSION} -F '#{pane_id}'`,
    ).trim();

    const row = page.locator(`[data-testid="loops-pane-row-${paneId}"]`);
    await expect(row).toBeVisible({ timeout: READY_TIMEOUT_MS });
    await row.click();

    const wrapper = page.locator("[data-testid=loops-pane-terminal]");
    await expect(wrapper.locator(".xterm").first()).toBeVisible({
      timeout: RENDER_TIMEOUT_MS,
    });
    await wrapper.locator(".xterm").first().click();
    await wrapper.locator(".xterm-helper-textarea").first().focus();

    const marker = `KEYS${Date.now().toString(36)}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");

    // tmux capture-pane reflects what the pane has received. The marker
    // appears once the library forwarded our keystrokes through
    // PaneStream.sendKeys → tmux send-keys -l.
    await expect
      .poll(
        () => tmux(server.socket, `capture-pane -p -t ${paneId}`),
        { timeout: RENDER_TIMEOUT_MS },
      )
      .toContain(marker);
  });
});
