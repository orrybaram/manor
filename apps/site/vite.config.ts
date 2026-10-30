import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const LATEST_RELEASE = "https://api.github.com/repos/orrybaram/manor/releases/latest";

/** The version in apps/desktop/package.json: what the checkout would release next. */
function checkoutVersion(): string {
  const pkg = fileURLToPath(new URL("../desktop/package.json", import.meta.url));
  const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
  return version;
}

/** The newest published release's version (its tag without the "v"), from GitHub. */
async function latestReleaseVersion(): Promise<string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release`);
  const { tag_name } = (await res.json()) as { tag_name: string };
  return tag_name.replace(/^v/, "");
}

/**
 * Fills `%MANOR_VERSION%` in index.html with the version the Download button
 * hands out: its label and its .dmg link both name the latest release. The
 * release workflow redeploys the site once a release is published.
 *
 * - `SITE_DOWNLOAD_VERSION=x.y.z` (not MANOR_VERSION: Manor sets that in its own terminal panes) pins it (the e2e spec does, so it runs offline).
 * - Otherwise a build asks GitHub; the dev server just uses the checkout.
 * - If GitHub can't be reached the checkout's version stands in, with a
 *   warning, unless `SITE_VERSION_STRICT=1` (set by `deploy`), which fails
 *   the build rather than ship a stale label.
 */
function manorVersion(): Plugin {
  let version = "";
  return {
    name: "manor-version",
    async configResolved(config) {
      const pinned = process.env.SITE_DOWNLOAD_VERSION;
      if (pinned) {
        version = pinned.replace(/^v/, "");
        return;
      }
      if (config.command !== "build") {
        version = checkoutVersion();
        return;
      }
      try {
        version = await latestReleaseVersion();
        config.logger.info(`manor-version: latest release is v${version}`);
      } catch (err) {
        if (process.env.SITE_VERSION_STRICT === "1") throw err;
        version = checkoutVersion();
        config.logger.warn(`manor-version: ${(err as Error).message}; using v${version} from apps/desktop/package.json`);
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replaceAll("%MANOR_VERSION%", version),
    },
  };
}

export default defineConfig({
  plugins: [manorVersion()],
  build: { target: "es2022" },
});
