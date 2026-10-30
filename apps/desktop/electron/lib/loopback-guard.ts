/**
 * Checks shared by Manor's loopback HTTP listeners (the control server and
 * the hook servers): only a local client that names this listener by its
 * loopback address and holds its per-launch token gets through.
 *
 * - `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
 * - No `Origin` header: Manor's own clients (CLI, MCP, hook scripts) never
 *   send one, and a browser always does on the requests that matter.
 * - The token header must match, compared in constant time.
 *
 * Electron-free: the daemon bundle and the standalone CLI bundle import this.
 */

import * as crypto from "node:crypto";
import type * as http from "node:http";

/** Mint a listener's per-launch token: 32 random bytes, hex. */
export function mintToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Whether `header` is exactly `token`, compared in constant time. */
export function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** A refusal: the status to answer with and why. */
export interface Refusal {
  status: number;
  error: string;
}

/**
 * Why `req` must be refused before anything reads it, or null if it may
 * proceed: a `Host` other than this listener's loopback address, any
 * `Origin`, or a missing or wrong token in `tokenHeader`.
 */
export function refuseLoopbackRequest(
  req: http.IncomingMessage,
  opts: { port: number; tokenHeader: string; token: string },
): Refusal | null {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) {
    return { status: 403, error: "Host not allowed" };
  }
  if (req.headers.origin !== undefined) {
    return { status: 403, error: "Origin not allowed" };
  }
  if (!tokenMatches(req.headers[opts.tokenHeader], opts.token)) {
    return { status: 401, error: "Missing or wrong token" };
  }
  return null;
}

/** Whether a `Content-Type` header names JSON (parameters like charset allowed). */
export function isJsonContentType(header: string | undefined): boolean {
  return header?.split(";")[0]?.trim().toLowerCase() === "application/json";
}
