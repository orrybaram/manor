import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "electron/**/*.test.ts",
      "tests/e2e/helpers/**/*.test.ts",
    ],
    setupFiles: [
      // Must run first: redirects $HOME to a temp dir.
      "electron/__tests__/setup-isolated-home.ts",
      // After the home redirect, so SESSIONS_DIR is the throwaway one (#310).
      "electron/__tests__/setup-sessions-guard.ts",
      "src/store/__tests__/setup.ts",
    ],
  },
});
