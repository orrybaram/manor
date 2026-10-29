import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/** Pin the Download label to the checkout's version, so the spec runs offline. */
const { version } = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")) as { version: string };

/** The homepage against its production build, served by `vite preview`. */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4179" },
  webServer: {
    command: "pnpm build && pnpm preview --port 4179 --strictPort --host 127.0.0.1",
    env: { SITE_DOWNLOAD_VERSION: version },
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
