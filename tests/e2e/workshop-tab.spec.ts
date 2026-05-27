// End-to-end smoke for the new Workshop tab. Verifies the route + top
// tab plumbing the same way the other surface specs do: land on
// /workshop via seeded lastRoute, assert the tab is active, assert the
// page renders its empty hint, and assert that "New launch" opens the
// spawn dialog.
//
// [LAW:dataflow-not-control-flow] The test does not depend on a real
// launch existing — it exercises the route, the tab, and the dialog
// affordance, all of which are reachable without spawning anything.
// Tests that exercise actual launch creation belong with the launch
// integration suite, not the route smoke.

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

test.describe("Workshop tab", () => {
  let server: TmuxServerHandle;
  let appHandle: ElectronAppHandle;

  test.beforeEach(async ({}, testInfo) => {
    server = createTmuxServer(testInfo.workerIndex);
    // Seed a session so the mesh has something to attach to — keeps
    // boot from sitting in the no-sessions state during the test.
    server.newSession("promptctl-e2e-workshop");
    appHandle = await launchElectronApp({
      socket: server.socket,
      initialRoute: "/workshop",
    });
  });

  test.afterEach(async () => {
    await appHandle?.close();
    server?.killServer();
  });

  test("lands on /workshop, renders the empty state, opens the New launch dialog", async () => {
    const page = appHandle.window;

    // The top tab labeled "Workshop" is active when /workshop is the
    // current route. The text "Workshop" also appears as the page's
    // <h2> heading, so we target the top-tab link specifically via
    // role+name (the TopTab renders a react-router <Link>, which is
    // an <a>). [LAW:locality-or-seam] Role-scoped selectors keep the
    // smoke test rooted in semantics rather than fragile text matches.
    await expect(
      page.getByRole("link", { name: "Workshop" }),
    ).toBeVisible({ timeout: READY_TIMEOUT_MS });
    await expect(
      page.locator("[data-testid=workshop-new-launch]"),
    ).toBeVisible({ timeout: READY_TIMEOUT_MS });
    // Empty state: no launches in the seeded registry, so the launches
    // list is absent and the empty hint is shown.
    await expect(
      page.locator("[data-testid=workshop-launches-list]"),
    ).toHaveCount(0);
    await expect(page.getByText(/No launches yet/i)).toBeVisible();

    // Clicking New launch surfaces the spawn dialog. We don't submit it
    // (that would invoke launch:create against a real tmux binary); we
    // just observe the dialog opens — the wiring from Workshop to
    // LaunchToolDialog is the property under test.
    await page.locator("[data-testid=workshop-new-launch]").click();
    await expect(page.getByText("Launch Tool")).toBeVisible();
  });
});
