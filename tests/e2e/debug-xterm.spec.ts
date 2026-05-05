// End-to-end verification for the xterm rendering slice.
//
// Drives the packaged app against an isolated tmux server. Asserts that
// /debug/tmux-control's PaneTerminal renders live tmux output through
// xterm.js: plain bytes land in the buffer, ANSI color escapes set cell
// attributes, and keystrokes flow back to tmux via the sendKeys path.
//
// The test reads xterm's own buffer through `window.__paneTerminal` —
// the same data structure the renderer-unit tests assert against, scaled
// up to a real tmux server end-to-end.

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

// `window.__paneTerminal` is set by PaneTerminal during its mount effect.
// The renderer side declares the global (in src/renderer/tmux/PaneTerminal.tsx)
// against the xterm.js Terminal type. Inside Playwright's `evaluate` the
// runtime is the renderer; the function body is type-checked against the
// browser's lib.dom Window, with the renderer-side global merged in.

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
  await expect(page.locator("[data-testid=pane-terminal]")).toBeVisible({
    timeout: RENDER_TIMEOUT_MS,
  });
  // The component sets window.__paneTerminal during the mount effect; wait
  // until it's populated so subsequent buffer reads don't race the mount.
  await page.waitForFunction(() => window.__paneTerminal !== undefined, {
    timeout: RENDER_TIMEOUT_MS,
  });
  return paneId;
}

test.describe("/debug/tmux-control xterm rendering", () => {
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

  test("plain bytes from tmux send-keys appear in xterm buffer", async () => {
    const page = appHandle.window;
    const paneId = await selectFirstPane(page);

    const marker = `MARKER_${Date.now().toString(36)}`;
    // `cat` echoes its stdin to stdout. Running cat first gives a
    // deterministic, line-buffered echo path — `cat` writes the line as-is
    // without prompt formatting.
    tmux(server.socket, `send-keys -t ${paneId} 'cat' Enter`);
    await page.waitForTimeout(200);
    tmux(server.socket, `send-keys -t ${paneId} '${marker}' Enter`);

    // Poll the active buffer for the marker. Any visible line containing
    // the marker satisfies the assertion — line position depends on shell
    // prompt height, which varies across machines.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const t = window.__paneTerminal?.terminal;
            if (t === undefined) return "";
            const buf = t.buffer.active;
            const out: string[] = [];
            for (let i = 0; i < buf.length; i++) {
              const line = buf.getLine(i);
              if (line !== undefined) out.push(line.translateToString(true));
            }
            return out.join("\n");
          }),
        { timeout: RENDER_TIMEOUT_MS },
      )
      .toContain(marker);
  });

  test("ANSI color escapes set cell foreground color attribute", async () => {
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

    // Poll the buffer for the COLORED occurrence of the marker. The plain
    // (typed-echo) occurrence has default colors and is rejected; the
    // shell's printf output paints cells with palette index 1 (red).
    await expect
      .poll(
        () =>
          page.evaluate((m: string) => {
            const t = window.__paneTerminal?.terminal;
            if (t === undefined) return null;
            const buf = t.buffer.active;
            for (let i = 0; i < buf.length; i++) {
              const line = buf.getLine(i);
              if (line === undefined) continue;
              const text = line.translateToString(true);
              const at = text.indexOf(m);
              if (at < 0) continue;
              const cell = line.getCell(at);
              if (cell === undefined) continue;
              if (!cell.isFgPalette()) continue;
              if (cell.getFgColor() !== 1) continue;
              return { isPalette: cell.isFgPalette(), fg: cell.getFgColor() };
            }
            return null;
          }, marker),
        { timeout: 20_000, intervals: [200, 500, 1000, 2000] },
      )
      .toEqual({ isPalette: true, fg: 1 });
  });

  test("typing into the page sends keystrokes to the pane via tmux", async () => {
    const page = appHandle.window;
    const paneId = await selectFirstPane(page);

    // Click on the xterm container so xterm's textarea captures focus.
    await page.locator("[data-testid=pane-terminal]").click();
    // xterm's hidden textarea is the input target; focus it explicitly so
    // synthetic keypresses route through xterm's onData handler.
    await page.evaluate(() => {
      const ta = document.querySelector(
        "[data-testid=pane-terminal] textarea",
      ) as HTMLTextAreaElement | null;
      ta?.focus();
    });

    // Pick a marker without shell-special characters.
    const marker = `KEYS${Date.now().toString(36)}`;
    await page.keyboard.type(marker);
    // Press Enter so cat / shell flushes the line.
    await page.keyboard.press("Enter");

    // tmux capture-pane shows what's currently rendered in the pane. The
    // marker should appear once xterm has forwarded the keystrokes through
    // sendKeys, tmux has fed them to the underlying process, and the
    // process has echoed them back.
    await expect
      .poll(
        () => tmux(server.socket, `capture-pane -p -t ${paneId}`),
        { timeout: RENDER_TIMEOUT_MS },
      )
      .toContain(marker);
  });
});
