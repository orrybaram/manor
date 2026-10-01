// Builds the web app for the relay's per-version R2 hosting (ADR-206 D4):
// base /app/<version>/, output dist-relay-web/<version>/. Cross-platform
// stand-in for setting MANOR_WEB_BASE / MANOR_WEB_OUT_DIR inline.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const result = spawnSync(
  "pnpm",
  ["exec", "vite", "build", "--config", "vite.web.config.ts"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      MANOR_WEB_BASE: `/app/${version}/`,
      MANOR_WEB_OUT_DIR: `dist-relay-web/${version}`,
    },
  },
);
process.exit(result.status ?? 1);
