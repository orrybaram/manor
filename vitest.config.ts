import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "electron/**/*.test.ts",
      "tests/e2e/helpers/**/*.test.ts",
    ],
    setupFiles: [
      // Must run first: redirects $HOME to a temp dir (ADR-169).
      "electron/__tests__/setup-isolated-home.ts",
      "src/store/__tests__/setup.ts",
    ],
  },
});
