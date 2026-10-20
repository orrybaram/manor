import { defineConfig } from "@playwright/test";

/**
 * Specs that time frames. Run alongside other Electron instances they measure
 * the machine's load, not the app, so they get the machine to themselves:
 * `pnpm test:e2e` runs the "perf" project one test at a time, after "e2e".
 * (Not a project dependency: that would drag the whole suite into a run of a
 * single perf spec.)
 */
const PERF_SPECS = ["**/diff-drag-perf.spec.ts", "**/resize-lockup.spec.ts"];

export default defineConfig({
  testDir: "./tests/e2e",
  // Every test launches its own app against its own temp HOME (fixtures.ts),
  // so tests share nothing and run in parallel. MANOR_E2E_WORKERS overrides.
  workers: process.env.MANOR_E2E_WORKERS ?? 4,
  fullyParallel: true,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "list",
  projects: [
    {
      name: "e2e",
      // helpers/ holds vitest unit tests; only *.spec.ts are Playwright's.
      testMatch: "**/*.spec.ts",
      testIgnore: PERF_SPECS,
    },
    {
      name: "perf",
      testMatch: PERF_SPECS,
      workers: 1,
    },
  ],
});
