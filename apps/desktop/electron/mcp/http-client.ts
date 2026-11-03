/**
 * Shared HTTP client for reaching Manor's webview control server, used by
 * both the MCP entry (`mcp-webview-server.ts`) and the `manor` CLI. Port
 * discovery and the "is Manor running?" error stay identical across both
 * surfaces.
 *
 * Discovery: reads port from ~/.manor/webview-server-port and the token that
 * server wants from ~/.manor/webview-server-token, unless
 * MANOR_CONTROL_PORT_FILE is set — see requestViaControlRelay() below.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { webviewServerPortFile, webviewServerTokenFile } from "../paths";
import type { Http } from "./types";
import { HttpError } from "./types";

const PORT_FILE = webviewServerPortFile();
const TOKEN_FILE = webviewServerTokenFile();

/**
 * Header carrying the token of whichever server this talks to: the remote
 * control relay or Manor desktop's webview server. Must match
 * `CONTROL_TOKEN_HEADER` in `electron/terminal-host/control-relay-listener.ts`
 * and `electron/webview-server.ts` — duplicated rather than imported, because
 * those are part of the daemon and Electron bundles and this one ships in the
 * standalone CLI bundle (`manor-cli.js`), which must stay electron- and
 * terminal-host-free.
 */
const CONTROL_TOKEN_HEADER = "x-manor-control-token";

const TOKEN_REFUSED_MESSAGE =
  "Manor refused this terminal's control token. Open a new terminal, or restart Manor";

const REMOTE_UNREACHABLE_MESSAGE =
  "Manor's remote daemon isn't reachable. Reconnect the host in Manor";

/**
 * Reads `<port>\n<token>\n` from the remote control port file
 * (`~/.manor/remote/control-port` on the daemon, named here by
 * `MANOR_CONTROL_PORT_FILE`). Re-read on every request rather than cached,
 * so a daemon restart — which mints a fresh token — doesn't wedge a shell
 * that was already open ("stale tokens"). Returns null if the
 * file is missing, unreadable, or malformed.
 */
function readControlPortFile(file: string): { port: number; token: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const [portLine, tokenLine] = raw.split("\n");
  const port = parseInt((portLine ?? "").trim(), 10);
  if (isNaN(port) || port <= 0) return null;
  const token = (tokenLine ?? "").trim();
  if (!token) return null;
  return { port, token };
}

/**
 * Send one request through the remote daemon's control relay
 * (`MANOR_CONTROL_PORT_FILE` set — i.e. this CLI is running in a terminal on
 * a remote host). There is exactly one target and no fallback to
 * `MANOR_WEBVIEW_PORT` or `~/.manor/webview-server-port`: a Manor desktop
 * running on this same box, if any, is not the one that owns this terminal.
 * A missing/unreadable port file or a refused connection both report the
 * same "isn't reachable" message; a live server's non-2xx response still
 * goes through the ordinary `HttpError` path below so its `error` body
 * reaches the caller.
 */
async function requestViaControlRelay(
  portFile: string,
  urlPath: string,
  init?: RequestInit,
  long = false,
): Promise<unknown> {
  const target = readControlPortFile(portFile);
  if (!target) throw new Error(REMOTE_UNREACHABLE_MESSAGE);

  let res: Answer;
  try {
    res = await send(
      `http://127.0.0.1:${target.port}${urlPath}`,
      {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          [CONTROL_TOKEN_HEADER]: target.token,
        },
      },
      long,
    );
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(REMOTE_UNREACHABLE_MESSAGE, { cause: err });
    }
    throw err;
  }
  return bodyOf(res);
}

// Candidate targets to reach Manor's webview server, in priority order, each
// a port and the token that server wants (`CONTROL_TOKEN_HEADER`):
//   1. MANOR_WEBVIEW_PORT + MANOR_WEBVIEW_TOKEN env — set by the host Manor
//      instance (correct target in multi-instance setups), but goes stale if
//      that instance restarts.
//   2. The ~/.manor/webview-server-port and -token files — always rewritten by
//      the running instance, so they self-heal after a restart. When they name
//      the same port as the env, the file's token wins: it is the fresher.
// Resolved per request (not cached at startup) so restarts don't wedge us.
function candidateTargets(): { port: number; token: string }[] {
  const targets: { port: number; token: string }[] = [];
  const filePort = fs.existsSync(PORT_FILE)
    ? parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10)
    : NaN;
  const fileToken = readTokenFile();
  const envPort = parseInt(process.env.MANOR_WEBVIEW_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0) {
    const token =
      envPort === filePort && fileToken ? fileToken : (process.env.MANOR_WEBVIEW_TOKEN ?? "");
    targets.push({ port: envPort, token });
  }
  if (!isNaN(filePort) && filePort > 0 && filePort !== envPort) {
    targets.push({ port: filePort, token: fileToken ?? "" });
  }
  if (targets.length === 0) {
    throw new Error(
      `No Manor webview port found (env MANOR_WEBVIEW_PORT or ${PORT_FILE}) — is Manor running?`,
    );
  }
  return targets;
}

/** The token in `TOKEN_FILE`, or null if it is missing, unreadable or empty. */
function readTokenFile(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * True for the connection-level `TypeError` `fetch` throws when nothing is
 * listening on a candidate port (as opposed to an HTTP error from a live
 * server). Shared so the CLI can print the same "is it running?" message
 * `handleTool` does.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as NodeJS.ErrnoException).cause;
  // undici's headers and body timeouts come as the same `TypeError`, but a
  // server was there and may be working on the request still.
  return Boolean(cause) && !TIMEOUT_CODES.has(codeOf(cause) ?? "");
}

/** undici's timeouts: a live server that took too long, not a missing one. */
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether a failed request may go to the next candidate port. A read may,
 * whatever broke its connection. A write only when nothing was listening
 * (`ECONNREFUSED`), so the request was never sent: anything else may have
 * reached a server that is still carrying it out, and sending it again
 * would do it twice.
 */
function retryOnNextPort(err: unknown, method: string): boolean {
  if (!isConnectionError(err)) return false;
  if (method === "GET") return true;
  return codeOf((err as NodeJS.ErrnoException).cause) === "ECONNREFUSED";
}

/** What a request's answer gives: `fetch`'s `Response`, or `nodeRequest`'s. */
interface Answer {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * A request over `node:http`, for one that may run for minutes (`long`).
 * Node's `fetch` gives up on a server that sends no headers for five
 * minutes (undici's `headersTimeout`), and a control route answers only
 * when its work is done; `node:http` waits until the request's own
 * `signal` says to stop. A refused connection fails as `fetch`'s does, so
 * callers tell it apart the same way.
 */
function nodeRequest(url: string, init: RequestInit): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers as http.OutgoingHttpHeaders | undefined,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ ok: status >= 200 && status < 300, status, text: async () => body });
        });
      },
    );
    req.on("error", (err) => {
      reject(codeOf(err) === "ECONNREFUSED" ? new TypeError("fetch failed", { cause: err }) : err);
    });
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}

function send(url: string, init: RequestInit | undefined, long: boolean): Promise<Answer> {
  return long ? nodeRequest(url, init ?? {}) : fetch(url, init);
}

/** A 2xx answer's JSON, or the `HttpError` a live server's error is. */
async function bodyOf(res: Answer): Promise<unknown> {
  const rawBody = await res.text();
  if (res.ok) return JSON.parse(rawBody);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // not JSON; body stays null
  }
  throw new HttpError(res.status, parsed, rawBody);
}

// Try each candidate port until one answers. A port with nothing on it
// (`retryOnNextPort`) and a refused token fall through to the next candidate;
// any other HTTP error from a live server is surfaced as-is (don't mask a real
// error by retrying a different instance).
async function request(urlPath: string, init?: RequestInit, long = false): Promise<unknown> {
  const controlPortFile = process.env.MANOR_CONTROL_PORT_FILE;
  if (controlPortFile) {
    return requestViaControlRelay(controlPortFile, urlPath, init, long);
  }

  let lastErr: unknown;
  for (const { port, token } of candidateTargets()) {
    let res: Answer;
    try {
      res = await send(
        `http://127.0.0.1:${port}${urlPath}`,
        {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            [CONTROL_TOKEN_HEADER]: token,
          },
        },
        long,
      );
    } catch (err) {
      lastErr = err;
      if (!retryOnNextPort(err, init?.method ?? "GET")) throw err;
      continue;
    }
    // A refused token may be a stale env pairing; the next candidate
    // (the files, always current) may still get through.
    if (res.status === 401) {
      lastErr = new Error(TOKEN_REFUSED_MESSAGE);
      continue;
    }
    return bodyOf(res);
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
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  };
  // A caller that names a timeout expects to wait (a move, an automation
  // run, a push): that timeout alone ends the wait (`nodeRequest`).
  if (timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(timeoutMs);
    return request(urlPath, init, true);
  }
  return request(urlPath, init);
}

async function httpDelete(
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
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
