/**
 * Serving the ADR-161 phone client off the remote-control listener.
 *
 * These bytes are the one part of the surface that is served **before**
 * authentication, and that is not an oversight: the pairing token arrives in
 * the URL *fragment*, which browsers never send to the server, so the page has
 * to load first and authenticate from JavaScript afterwards. What is served
 * here is the app shell — HTML, CSS, and a bundle — and no session data, no
 * device list, and no token. Everything that reads state stays behind the auth
 * pipeline in `server.ts`.
 *
 * The CSP is the other half of that trade: `default-src 'none'` with `'self'`
 * for the bundle means a page holding a bearer token cannot be talked into
 * shipping it anywhere.
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

/**
 * Serve one static file, or return false so the caller falls through to the
 * authenticated pipeline.
 *
 * Traversal is handled by resolving first and then requiring the result to sit
 * inside `dir` — a check on the request string would have to anticipate every
 * encoding, and this one cannot be talked around.
 */
export function serveClientAsset(
  res: ServerResponse,
  pathname: string,
  dir: string | null,
): boolean {
  if (!dir) return false;

  const relative =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
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
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    // The bundle is content-hashed and may be pinned. The shell and the
    // service worker are not: both are fetched by a stable name, and a phone
    // holding either for a year would keep running a client this build has
    // replaced.
    "Cache-Control":
      resolved.endsWith(".html") || path.basename(resolved) === "sw.js"
        ? "no-store"
        : "public, max-age=31536000, immutable",
  });
  res.end(contents);
  return true;
}
