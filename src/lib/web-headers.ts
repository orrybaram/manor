/**
 * Headers for serving the ADR-178 web app, shared by the relay Worker
 * (`relay/src/index.ts`, ADR-206 D4) — the only server the web app has since
 * ADR-207 — and `vite.web.config.ts`. Dependency-free on purpose: the Worker
 * cannot import Node modules.
 */

/**
 * The web app's CSP. Locked to same-origin for everything: no CDN, no third-party script, no cross-origin fetch.
 * `connect-src 'self'` covers same-origin `ws:`/`wss:` under CSP3 in both
 * Chrome and Safari, so the relay's same-origin `wss://…/join/<room>` socket
 * needs nothing extra.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "worker-src 'self'",
].join("; ");

/**
 * Cache policy: the shell, the service worker and the manifest are served
 * under stable names (a version's `sw.js` keeps its name across rebuilds of
 * that version), so they are never cached; everything else is hashed.
 */
export function webCacheControl(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  return base.endsWith(".html") ||
    base === "sw.js" ||
    base.endsWith(".webmanifest")
    ? "no-store"
    : "public, max-age=31536000, immutable";
}

/**
 * Content types for the web app's files, by extension. One table for every
 * server of the build, so a new asset type (the terminal's `.ttf` fonts were
 * the one that slipped) is added once. A type matters beyond the browser:
 * Cloudflare compresses `font/ttf` at the edge but not
 * `application/octet-stream`.
 */
const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The `Content-Type` to serve `filename` with. */
export function webContentType(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return (
    WEB_CONTENT_TYPES[base.slice(dot).toLowerCase()] ??
    "application/octet-stream"
  );
}
