// [LAW:single-enforcer] One Playwright config; all e2e tests inherit from it.
// Tests live under tests/e2e/. The TMUX_INTEGRATION=1 gate matches the
// vitest integration suite — default `npm test` runs neither.

import { defineConfig } from "@playwright/test";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  // [LAW:single-enforcer] Convention split: vitest owns `*.test.ts`,
  // Playwright owns `*.spec.ts`. Without the explicit match Playwright
  // would try to load fixture unit tests under tests/e2e/ as e2e specs.
  testMatch: /.*\.spec\.ts$/,
  // Per-worker isolation: each worker spins up its own tmux server (-L <nonce>),
  // and each test gets a fresh Electron process. Parallel safe.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "retain-on-failure",
  },
  // Skip everything unless TMUX_INTEGRATION=1 — the suite drives a real tmux
  // server and a real Electron build, so it must opt-in. Without the gate
  // contributors who don't have tmux + a packaged build see nothing.
  grep: RUN_INTEGRATION ? /.*/ : /__never__/,
});
