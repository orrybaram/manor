import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** The desktop app's version: the one the Download button hands out. */
function desktopVersion(): string {
  const pkg = fileURLToPath(new URL("../desktop/package.json", import.meta.url));
  const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
  return version;
}

/** Fills `%MANOR_VERSION%` in index.html from apps/desktop/package.json at build time. */
function manorVersion(): Plugin {
  return {
    name: "manor-version",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replaceAll("%MANOR_VERSION%", desktopVersion()),
    },
  };
}

export default defineConfig({
  plugins: [manorVersion()],
  build: { target: "es2022" },
});
