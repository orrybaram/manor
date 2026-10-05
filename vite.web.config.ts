import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "./package.json";
import { WEB_CSP } from "./src/lib/web-headers";

/**
 * `src/web.html`'s CSP `<meta>` tag is a second line of defence for the same
 * header the relay sends for `/app/<version>/` — this keeps the HTML from
 * drifting out of sync with `WEB_CSP`, the one source, rather than trusting
 * the two to stay hand-copied.
 */
function injectWebCsp(): Plugin {
  return {
    name: "inject-web-csp",
    transformIndexHtml(html) {
      return html.replace(
        "<!--csp-->",
        `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />`,
      );
    },
  };
}

/** The web app's own icons, for the manifest and the Home Screen. */
const ICONS_DIR = path.resolve(__dirname, "src/web/icons");
const ICONS = [
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];

/**
 * Installable (ADR-206 D7): iOS grants Web Push only to a page added to the Home Screen *as a web app* —
 * without a manifest (or `apple-mobile-web-app-capable`) Add to Home Screen
 * makes a plain bookmark that opens in Safari, where there is no
 * `PushManager`, and the "Add to Home Screen" strip could never go away.
 *
 * Emits `manifest.webmanifest` (`src/web/manifest.webmanifest`, whose
 * `start_url` and icons are relative, so they resolve under whatever base
 * this build has — `/app/<version>/` on the relay)
 * and the icons beside it, and links them from the HTML with the base
 * spelled out. `scope` and `id` are `/app/` on purpose: an installed relay
 * app that the version redirect moves to `/app/<new>/` stays inside its own
 * scope (and stays the same installed app) instead of leaving it. Not via `publicDir`: that is the repo-root `public/` the
 * desktop renderer shares.
 */
function webAppManifest(): Plugin {
  let base = "/";
  return {
    name: "web-app-manifest",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml() {
      const meta = (name: string, content: string) => ({
        tag: "meta",
        attrs: { name, content },
        injectTo: "head" as const,
      });
      return [
        {
          tag: "link",
          attrs: { rel: "manifest", href: `${base}manifest.webmanifest` },
          injectTo: "head",
        },
        meta("theme-color", "#1e1e2e"),
        meta("mobile-web-app-capable", "yes"),
        meta("apple-mobile-web-app-capable", "yes"),
        // Installed, iOS gives the app its default status bar — white over a
        // dark app. Opaque black keeps the content clear of the notch with no
        // safe-area padding to get wrong.
        meta("apple-mobile-web-app-status-bar-style", "black"),
        meta("apple-mobile-web-app-title", "Manor"),
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: `${base}icons/apple-touch-icon.png`,
          },
          injectTo: "head",
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: readFileSync(
          path.resolve(__dirname, "src/web/manifest.webmanifest"),
        ),
      });
      for (const icon of ICONS) {
        this.emitFile({
          type: "asset",
          fileName: `icons/${icon}`,
          source: readFileSync(path.join(ICONS_DIR, icon)),
        });
      }
    },
  };
}

/**
 * The ADR-178 web app: the desktop renderer, built a second time for a
 * browser and served by the relay at `/app/<version>/` (ADR-206 D4). Not
 * part of `pnpm build`: `pnpm build:web:relay` (`scripts/build-web-relay.mjs`)
 * builds it with that base into `dist-relay-web/<version>/`. `pnpm build:web`
 * builds it with the default base into `dist-web/`, as a quick check that it
 * bundles.
 *
 * Separate from `vite.config.ts` because that config's extra entries all go
 * through `vite-plugin-electron`, which targets Node, and
 * `vite-plugin-electron-renderer`, which exists to polyfill Node globals a
 * *desktop* renderer running under Electron might reach for. This bundle
 * never does — `src/` imports nothing from `"electron"` or a Node built-in,
 * and reaches everything through `window.electronAPI` — so it needs neither
 * plugin, just `@vitejs/plugin-react` and an ordinary browser build.
 *
 * `root: "src"` so the build can resolve `./App`, `./lib/*`, etc. exactly as
 * `vite.config.ts`'s implicit root does. The base is absolute, not `"./"`:
 * a relative base resolves against the *document's* URL, and a page URL
 * missing its trailing slash has no path segment for `./assets/…` to resolve
 * underneath, so the browser would request `/assets/…` instead. An absolute
 * base names the one prefix this bundle is ever served at and does not care
 * what the document's own URL looked like.
 */
export default defineConfig({
  root: path.resolve(__dirname, "src"),
  base: process.env.MANOR_WEB_BASE ?? "/app/",
  // Fonts referenced by `App.css` (`@font-face`) come from the repo-root
  // `public/`, not `src/public/` — `root: "src"` would otherwise default to
  // the latter, which does not exist, and the app would boot with no
  // terminal font to load.
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react(), injectWebCsp(), webAppManifest()],
  build: {
    outDir: path.resolve(
      __dirname,
      process.env.MANOR_WEB_OUT_DIR ?? "dist-web",
    ),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: path.resolve(__dirname, "src/web.html"),
        // Un-hashed, at the root of the base it controls (ADR-206 D7): the
        // registration scope is the base, so a version path owns its own.
        sw: path.resolve(__dirname, "src/web/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
