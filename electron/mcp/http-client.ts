/**
 * Shared HTTP client for reaching Manor's webview control server, used by
 * both the MCP entry (`mcp-webview-server.ts`) and the `manor` CLI. Port
 * discovery and the "is Manor running?" error stay identical across both
 * surfaces.
 *
 * Discovery: reads port from ~/.manor/webview-server-port
 */

import * as fs from "node:fs";
import { webviewServerPortFile } from "../paths";
import type { Http } from "./types";
import { HttpError } from "./types";

const PORT_FILE = webviewServerPortFile();

// Candidate ports to reach Manor's webview server, in priority order:
//   1. MANOR_WEBVIEW_PORT env — set by the host Manor instance (correct target
//      in multi-instance setups), but goes stale if that instance restarts.
//   2. The ~/.manor/webview-server-port file — always rewritten by the running
//      instance, so it self-heals after a restart.
// Resolved per request (not cached at startup) so restarts don't wedge us.
function candidatePorts(): number[] {
  const ports: number[] = [];
  const envPort = parseInt(process.env.MANOR_WEBVIEW_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0) ports.push(envPort);
  if (fs.existsSync(PORT_FILE)) {
    const filePort = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
    if (!isNaN(filePort) && filePort > 0 && !ports.includes(filePort)) {
      ports.push(filePort);
    }
  }
  if (ports.length === 0) {
    throw new Error(
      `No Manor webview port found (env MANOR_WEBVIEW_PORT or ${PORT_FILE}) — is Manor running?`,
    );
  }
  return ports;
}

/**
 * True for the connection-level `TypeError` `fetch` throws when nothing is
 * listening on a candidate port (as opposed to an HTTP error from a live
 * server). Shared so the CLI can print the same "is it running?" message
 * `handleTool` does.
 */
export function isConnectionError(err: unknown): boolean {
  return err instanceof TypeError && Boolean((err as NodeJS.ErrnoException).cause);
}

// Try each candidate port until one answers. Connection-level failures fall
// through to the next candidate; an HTTP error from a live server is surfaced
// as-is (don't mask a real error by retrying a different instance).
async function request(urlPath: string, init?: RequestInit): Promise<unknown> {
  let lastErr: unknown;
  for (const port of candidatePorts()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, init);
      if (!res.ok) {
        const rawBody = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          // not JSON; body stays null
        }
        throw new HttpError(res.status, parsed, rawBody);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err)) throw err;
    }
  }
  throw lastErr;
}

// ── HTTP helpers ──

async function httpGet(urlPath: string): Promise<unknown> {
  return request(urlPath);
}

async function httpPost(
  urlPath: string,
  body?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const init: RequestInit = {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  if (timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  return request(urlPath, init);
}

async function httpDelete(
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  return request(urlPath, init);
}

export function createHttp(): Http {
  return {
    get: httpGet,
    post: httpPost,
    del: httpDelete,
  };
}
