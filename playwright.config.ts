// [LAW:single-enforcer] One Playwright config; all e2e tests inherit from it.
// E2E specs run unconditionally as part of `npm test` — tmux is a hard
// project requirement (see README boundaries) and `pretest:e2e` packages
// the app fresh, so there is no environment in which gating these tests
// behind an opt-in env var would surface a real signal. Hiding e2e
// regressions until someone happens to flip the flag is exactly how the
// 77e.1.4 ensureSession regression slipped through.

import { defineConfig } from "@playwright/test";

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
});
