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
 * know at build time, so every asset reference has to be relative — including
 * the ones inside `manifest.webmanifest`, which is why the manifest and its
 * icons live in `public/` and are copied verbatim rather than being processed
 * into hashed asset names the manifest's own JSON could not be rewritten to
 * follow.
 */
export default defineConfig({
  root: path.resolve(__dirname, "src/remote-client"),
  base: "./",
  publicDir: path.resolve(__dirname, "src/remote-client/public"),
  build: {
    outDir: path.resolve(__dirname, "dist-electron/remote"),
    emptyOutDir: true,
    // No CDN, no external anything: the CSP the listener sends is
    // `default-src 'none'` plus `'self'`, so the bundle must be self-contained.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "src/remote-client/index.html"),
        // The service worker must land at a stable, un-hashed path at the root
        // of the scope it controls — a hashed filename would change its scope
        // and orphan every existing registration.
        sw: path.resolve(__dirname, "src/remote-client/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
