import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import pkg from "./package.json";

/**
 * The ADR-178 web app: the desktop renderer, built a second time for a
 * browser and served at `/app` by the remote-control listener.
 *
 * Separate from `vite.config.ts` for the same reason `vite.remote.config.ts`
 * is: that config's extra entries all go through `vite-plugin-electron`,
 * which targets Node, and `vite-plugin-electron-renderer`, which exists to
 * polyfill Node globals a *desktop* renderer running under Electron might
 * reach for. This bundle never does — `src/` imports nothing from
 * `"electron"` or a Node built-in, and reaches everything through
 * `window.electronAPI` — so it needs neither plugin, just `@vitejs/plugin-react`
 * and an ordinary browser build.
 *
 * `root: "src"` so the build can resolve `./App`, `./lib/*`, etc. exactly as
 * `vite.config.ts`'s implicit root does. `base: "./"` because `/app` is one
 * path among several this listener serves, at a tunnel hostname unknown at
 * build time — the same reason `vite.remote.config.ts` sets it.
 */
export default defineConfig({
  root: path.resolve(__dirname, "src"),
  base: "./",
  // Fonts referenced by `App.css` (`@font-face`) come from the repo-root
  // `public/`, not `src/public/` — `root: "src"` would otherwise default to
  // the latter, which does not exist, and the app would boot with no
  // terminal font to load.
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist-electron/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: path.resolve(__dirname, "src/web.html"),
      },
    },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
