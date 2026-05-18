// End-to-end verification for the library-backed xterm rendering on
// /debug/tmux-control. Drives the packaged app against an isolated tmux
// server and asserts that selecting a pane mounts @promptctl/pane-terminal's
// <PaneTerminal>, that live tmux output reaches the xterm grid through
// PaneStream's client.on("output") subscription, and that keystrokes flow
// back to tmux via PaneStream.sendKeys.
//
// Observation strategy: xterm's rendered DOM is authoritative. `.xterm`
// (the wrapping element) signals mount; `.xterm-rows` exposes the rendered
// text; `.xterm-helper-textarea` is xterm's hidden input target. This
// mirrors the pattern the library's own e2e tests use against the
// web-multiplexer demo — what the user sees IS what we test.

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

const OWNED_SESSION = "promptctl-e2e-xterm";

function tmux(socket: string, args: string): string {
  return execSync(`tmux -L ${socket} ${args}`, { encoding: "utf-8" });
}

async function selectFirstPane(page: import("playwright").Page): Promise<string> {
  await expect(page.locator("[data-testid=control-status]")).toHaveText(
    "ready",
    { timeout: READY_TIMEOUT_MS },
  );
  const countLocator = page.locator("[data-testid=topology-pane-count]");
  await expect(countLocator).not.toHaveText("0", {
    timeout: READY_TIMEOUT_MS,
  });

  // Settle: wait for topology row to materialize before snapshotting.
  await page.waitForTimeout(150);
  const paneIds = await page
    .locator("[data-pane-row]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-pane-row") ?? ""),
    );
  expect(paneIds.length).toBeGreaterThanOrEqual(1);
  const paneId = paneIds[0];
  expect(paneId.startsWith("%")).toBe(true);
  await page.locator(`[data-testid="watch-${paneId}"]`).click();
  // The library's <PaneTerminal> renders a `.xterm` wrapper once XtermSink
  // mounts the Terminal. That's the single observable mount signal.
  await expect(
    page.locator("[data-testid=pane-terminal] .xterm").first(),
  ).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
  return paneId;
}

test.describe("/debug/tmux-control xterm rendering", () => {
  let server: TmuxServerHandle;
  let appHandle: ElectronAppHandle;
  let rendererErrors: string[];

  test.beforeEach(async ({}, testInfo) => {
    server = createTmuxServer(testInfo.workerIndex);
    appHandle = await launchElectronApp({
      socket: server.socket,
      initialRoute: "/debug/tmux-control",
      env: { PROMPTCTL_TMUX_SESSION: OWNED_SESSION },
    });
    // [LAW:verifiable-goals] Any uncaught renderer error fails the test —
    // including the silent ones that wouldn't disturb a DOM assertion. This
    // is how the chunk-A debug session surfaced the two-Reacts crash:
    // `Cannot read properties of null (reading 'useRef')` rendered nothing
    // visible, but pageerror fired. Keep it permanent.
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

  test("plain bytes from tmux send-keys appear in xterm rows", async () => {
    const page = appHandle.window;
    const paneId = await selectFirstPane(page);

    const marker = `MARKER_${Date.now().toString(36)}`;
    // `cat` echoes its stdin to stdout. Running cat first gives a
    // deterministic, line-buffered echo path — `cat` writes the line as-is
    // without prompt formatting.
    tmux(server.socket, `send-keys -t ${paneId} 'cat' Enter`);
    await page.waitForTimeout(200);
    tmux(server.socket, `send-keys -t ${paneId} '${marker}' Enter`);

    // The xterm-rows element's text content is the rendered grid as text.
    // Any visible line containing the marker satisfies the assertion —
    // line position depends on shell prompt height, which varies across
    // machines.
    await expect(
      page.locator("[data-testid=pane-terminal] .xterm-rows").first(),
    ).toContainText(marker, { timeout: RENDER_TIMEOUT_MS });
  });

  test("ANSI color escapes set red foreground on rendered cells", async () => {
    const page = appHandle.window;
    const paneId = await selectFirstPane(page);

    // Drive ANSI bytes through the shell's `printf`. The shell may not be
    // ready to accept input the instant the pane appears in topology
    // (cold-start under parallel CPU load), but typed bytes queue in the
    // pane's input buffer; once the shell prompt is reached, it parses and
    // runs printf, which emits the colored bytes that xterm parses.
    //
    // \033 is portable across bash and zsh printf; \e isn't.
    const marker = `RED${Date.now().toString(36)}`;
    tmux(
      server.socket,
      `send-keys -t ${paneId} "printf '\\033[31m${marker}\\033[0m\\n'" Enter`,
    );

    // xterm renders palette foreground colors as inline-styled `<span>`s with
    // the class `xterm-fg-1` (palette index 1 = red). Asserting on a span
    // whose text contains the marker AND whose class is `xterm-fg-1` proves
    // the byte stream carried the escape AND xterm parsed it AND the renderer
    // applied the color attribute.
    await expect(
      page
        .locator("[data-testid=pane-terminal] .xterm-rows span.xterm-fg-1")
        .filter({ hasText: marker })
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("typing into the page sends keystrokes to the pane via tmux", async () => {
    const page = appHandle.window;
    const paneId = await selectFirstPane(page);

    // xterm focuses its `.xterm-helper-textarea` on click. Force focus
    // explicitly so synthetic keypresses route through xterm's onData
    // handler → PaneStream.sendKeys → tmux send-keys -l.
    await page.locator("[data-testid=pane-terminal] .xterm").first().click();
    const textarea = page
      .locator("[data-testid=pane-terminal] .xterm-helper-textarea")
      .first();
    await textarea.focus();

    // Pick a marker without shell-special characters.
    const marker = `KEYS${Date.now().toString(36)}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");

    // tmux capture-pane shows what's currently rendered in the pane. The
    // marker should appear once xterm forwarded the keystrokes through
    // sendKeys, tmux fed them to the shell, and the shell echoed them.
    await expect
      .poll(
        () => tmux(server.socket, `capture-pane -p -t ${paneId}`),
        { timeout: RENDER_TIMEOUT_MS },
      )
      .toContain(marker);
  });
});
