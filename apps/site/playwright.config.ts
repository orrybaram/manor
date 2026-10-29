import { defineConfig } from "@playwright/test";

/** The homepage against its production build, served by `vite preview`. */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4179" },
  webServer: {
    command: "pnpm build && pnpm preview --port 4179 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
