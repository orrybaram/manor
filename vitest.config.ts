import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
    setupFiles: ["src/store/__tests__/setup.ts"],
  },
});
