/**
 * Serving the ADR-161 phone client and the ADR-178 web app off the
 * remote-control listener.
 *
 * These bytes are the one part of the surface that is served **before**
 * authentication, and that is not an oversight: the pairing token arrives in
 * the URL *fragment*, which browsers never send to the server, so the page has
 * to load first and authenticate from JavaScript afterwards. What is served
 * here is an app shell — HTML, CSS, and a bundle — and no session data, no
 * device list, and no token. Everything that reads state stays behind the auth
 * pipeline in `server.ts`.
 *
 * Two shells, two directories, two CSPs. The remote client at `/` is the
 * ADR-161 phone page: `default-src 'none'` with `'self'` for the bundle means
 * a page holding a bearer token cannot be talked into shipping it anywhere.
 * The web app at `/app` is the whole desktop renderer (ADR-178 D1) — it needs
 * `'wasm-unsafe-eval'` for xterm's WASM addons, inline styles for
 * CSS-in-component patterns already in `src/`, and a same-origin WebSocket for
 * ticket 4's bridge — so it gets the narrowest policy that lets *that* bundle
 * run, not the remote client's.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The web app's CSP. Looser than the remote client's on purpose — it is the
 * full desktop renderer, not a 16 KB page — but still locked to same-origin
 * for everything: no CDN, no third-party script, no cross-origin fetch.
 * `connect-src 'self'` covers same-origin `ws:`/`wss:` under CSP3 in both
 * Chrome and Safari, so it does not need to be named separately.
 *
 * Exported so `vite.web.config.ts` can inject the same policy into
 * `src/web.html`'s `<meta>` tag at build time — the second line of defence
 * for a browser that, for whatever reason, does not see this header.
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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Where `vite.remote.config.ts` puts the built client, relative to the bundle. */
export function defaultClientDir(): string | null {
  // Undefined under vitest's ESM transform; the listener simply serves no
  // client in that case, which is what its tests want anyway.
  return typeof __dirname === "string" ? path.join(__dirname, "remote") : null;
}

/** Where `vite.web.config.ts` puts the built web app, relative to the bundle. */
export function defaultWebDir(): string | null {
  return typeof __dirname === "string" ? path.join(__dirname, "web") : null;
}

/**
 * Serve one static file, or return false so the caller falls through to the
 * authenticated pipeline.
 *
 * Traversal is handled by resolving first and then requiring the result to sit
 * inside `dir` — a check on the request string would have to anticipate every
 * encoding, and this one cannot be talked around.
 */
function serveStaticFile(
  res: ServerResponse,
  dir: string,
  relative: string,
  csp: string,
): boolean {
  const resolved = path.resolve(dir, relative);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;

  let contents: Buffer;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    contents = fs.readFileSync(resolved);
  } catch {
    return false;
  }

  res.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream",
    "Content-Security-Policy": csp,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    // The bundle is content-hashed and may be pinned. The shell and the
    // service worker are not: both are fetched by a stable name, and a phone
    // (or browser) holding either for a year would keep running a build this
    // one has replaced.
    "Cache-Control":
      resolved.endsWith(".html") || path.basename(resolved) === "sw.js"
        ? "no-store"
        : "public, max-age=31536000, immutable",
  });
  res.end(contents);
  return true;
}

/** Serve the ADR-161 remote client, mounted at `/`. */
export function serveClientAsset(
  res: ServerResponse,
  pathname: string,
  dir: string | null,
): boolean {
  if (!dir) return false;
  const relative =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  return serveStaticFile(res, dir, relative, CSP);
}

/**
 * Serve the ADR-178 web app, mounted at `/app`.
 *
 * Only called for a pathname that *is* `/app` or starts with `/app/` — see
 * `server.ts` — so the prefix is always present and is stripped before
 * resolving against `dir`. `/app` and `/app/` both serve the shell, the way
 * `/` does for the remote client above; `vite.web.config.ts` names its build
 * `web.html` rather than `index.html`, so that is the file mapped to.
 */
export function serveWebAsset(
  res: ServerResponse,
  pathname: string,
  dir: string | null,
): boolean {
  if (!dir) return false;
  const rest = pathname.slice("/app".length).replace(/^\/+/, "");
  const relative = rest === "" ? "web.html" : rest;
  return serveStaticFile(res, dir, relative, WEB_CSP);
}
