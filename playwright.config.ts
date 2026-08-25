import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // Specs only. Helpers under `tests/e2e/helpers` carry their own unit tests,
  // which vitest runs — without this they are collected here too, where there
  // is no Electron app to drive and nothing they need.
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "list",
  fullyParallel: false,
});
