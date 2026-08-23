import { defineConfig } from "vite";
import path from "node:path";

/**
 * The ADR-161 phone client, built on its own.
 *
 * Separate from `vite.config.ts` because that config's extra entries all go
 * through `vite-plugin-electron`, which targets Node — this one is an ordinary
 * browser bundle with an HTML entry. It writes into `dist-electron/remote/`,
 * which the remote-control listener serves at `/`.
 *
 * `base: "./"` matters: the page is served from a tunnel hostname we do not
 * know at build time, so every asset reference has to be relative.
 */
export default defineConfig({
  root: path.resolve(__dirname, "src/remote-client"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist-electron/remote"),
    emptyOutDir: true,
    // No CDN, no external anything: the CSP the listener sends is
    // `default-src 'none'` plus `'self'`, so the bundle must be self-contained.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.resolve(__dirname, "src/remote-client/index.html"),
    },
  },
});
