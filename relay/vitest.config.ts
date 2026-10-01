import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Small enough that one test can spend it.
          RELAY_DAILY_BYTES: "65536",
          // Short enough that a test can wait out a heartbeat.
          RELAY_STALE_MS: "3000",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
