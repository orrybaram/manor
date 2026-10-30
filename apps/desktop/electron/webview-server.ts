/**
 * Webview HTTP server — local API for inspecting and interacting with
 * browser webviews embedded in panes.
 *
 * Follows the same lifecycle pattern as AgentHookServer in agent-hooks.ts.
 * Listens on 127.0.0.1 only with a random port, written to a port file.
 *
 * Every route this server answers — including `/webviews`, `/recordings` and
 * `/webview/:id/*`, once handled inline here — now lives in
 * `electron/routes/webview.ts`, part of the same table `electron/routes/`
 * dispatches for every other Manor-control route. This class keeps
 * only what a route handler cannot own itself: the HTTP listener's lifecycle,
 * console-message capture, and the pane→`WebContents` lookup those routes
 * reach through `HostDeps.webviewPanes`.
 *
 * Only Manor's own local clients get through: each request must name this
 * listener by its loopback `Host`, carry no `Origin`, and send the per-launch
 * token (`CONTROL_TOKEN_HEADER`) published in `webviewServerTokenFile()` and,
 * to child shells, as `MANOR_WEBVIEW_TOKEN`. A POST or DELETE must also
 * declare a JSON body.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { webContents } from "electron";
import { writeFileAtomic } from "./lib/fs-atomic";
import { isJsonContentType, mintToken, refuseLoopbackRequest } from "./lib/loopback-guard";
import { webviewServerPortFile, webviewServerTokenFile } from "./paths";
import { handleControlRequest } from "./routes";
import type { ConsoleEntry, HostDeps } from "./routes/types";

const MAX_CONSOLE_ENTRIES = 200;

const PORT_FILE = webviewServerPortFile();
const TOKEN_FILE = webviewServerTokenFile();

/**
 * The request header carrying the token. The same name the remote control
 * relay uses (`electron/terminal-host/control-relay-listener.ts`), so
 * `electron/mcp/http-client.ts` sends one header to either.
 */
export const CONTROL_TOKEN_HEADER = "x-manor-control-token";

export class WebviewServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = "";
  /** paneId → buffered console entries. Part of `HostDeps.webviewPanes`. */
  readonly consoleLogs: Map<string, ConsoleEntry[]> = new Map();
  private consoleListeners: Map<string, () => void> = new Map(); // paneId → cleanup fn

  /**
   * `getDeps` is what the control routes run over: the one
   * `HostDeps` the bridge handlers get too. A getter rather than
   * the object because that object holds this server — `app-lifecycle.ts`
   * builds it after constructing us — and the first request cannot arrive
   * before `start()`, which runs once it exists.
   */
  constructor(
    /** paneId → webContentsId. Part of `HostDeps.webviewPanes`. */
    readonly registry: Map<string, number>,
    readonly getDeps: () => HostDeps,
  ) {}

  get serverPort(): number {
    return this.port;
  }

  /** This launch's token; empty until `start()` has listened. */
  get controlToken(): string {
    return this.token;
  }

  /** Start the HTTP server on a random port */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("[webview-server] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.token = mintToken();
          // Token first: a client that reads the new port must find its token.
          writeFileAtomic(TOKEN_FILE, this.token, { mode: 0o600 });
          fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
          fs.writeFileSync(PORT_FILE, String(this.port));
        }
        resolve();
      });
    });
  }

  stop(): void {
    // Detach all console listeners
    for (const paneId of this.consoleListeners.keys()) {
      this.detachConsoleListener(paneId);
    }
    this.consoleLogs.clear();

    this.server?.close();
    this.server = null;
    // Only if the port file still names this listener: another Manor
    // sharing ~/.manor (a relaunch, a dev build) may have rewritten both
    // since, and its shells' only way back to it is these files.
    try {
      if (fs.readFileSync(PORT_FILE, "utf-8").trim() !== String(this.port)) return;
    } catch {
      // Port file gone or unreadable; the token file may still be ours.
    }
    for (const file of [PORT_FILE, TOKEN_FILE]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // File may not exist; ignore
      }
    }
  }

  /** Attach a console-message listener to a webview's webContents */
  attachConsoleListener(paneId: string): void {
    const wcId = this.registry.get(paneId);
    if (wcId == null) return;

    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;

    // Initialize the log buffer
    if (!this.consoleLogs.has(paneId)) {
      this.consoleLogs.set(paneId, []);
    }

    const levelMap: Record<number, ConsoleEntry["level"]> = {
      0: "log",
      1: "warn",
      2: "error",
      3: "info",
    };

    const listener = (
      _event: Electron.Event,
      level: number,
      message: string,
    ) => {
      const entries = this.consoleLogs.get(paneId);
      if (!entries) return;

      entries.push({
        timestamp: new Date().toISOString(),
        level: levelMap[level] ?? "log",
        message,
      });

      // Ring buffer: keep last MAX_CONSOLE_ENTRIES
      if (entries.length > MAX_CONSOLE_ENTRIES) {
        entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
      }
    };

    // The page-dialog shim's synchronous request (webview-dialogs.ts) needs no
    // filtering here: Chromium reports "[Deprecation] Synchronous
    // XMLHttpRequest on the main thread…" as a DevTools issue
    // (`Audits.issueAdded`), not a console message, so it never reaches this
    // event (checked on Electron 44). DevTools' Issues panel lists it, at
    // `manor-page-dialogs.js`.
    wc.on("console-message", listener);
    this.consoleListeners.set(paneId, () => {
      if (!wc.isDestroyed()) {
        wc.off("console-message", listener);
      }
    });
  }

  /** Detach the console-message listener for a pane */
  detachConsoleListener(paneId: string): void {
    const cleanup = this.consoleListeners.get(paneId);
    if (cleanup) {
      cleanup();
      this.consoleListeners.delete(paneId);
    }
    this.consoleLogs.delete(paneId);
  }

  /**
   * Look up and validate webContents for a paneId. Part of
   * `HostDeps.webviewPanes`: every `/webview/:paneId/*` route
   * in `electron/routes/webview.ts` resolves through this.
   */
  getWebContents(
    paneId: string,
  ): { wc: Electron.WebContents } | { error: string; status: number } {
    const wcId = this.registry.get(paneId);
    if (wcId == null) {
      return { error: "Webview not found", status: 404 };
    }

    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) {
      this.registry.delete(paneId);
      this.detachConsoleListener(paneId);
      return { error: "Webview destroyed", status: 410 };
    }

    return { wc };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // JSON helper
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const refusal = refuseLoopbackRequest(req, {
      port: this.port,
      tokenHeader: CONTROL_TOKEN_HEADER,
      token: this.token,
    });
    if (refusal) {
      req.resume();
      json(refusal.status, { error: refusal.error });
      return;
    }

    const method = req.method ?? "GET";
    if (
      (method === "POST" || method === "DELETE") &&
      !isJsonContentType(req.headers["content-type"])
    ) {
      req.resume();
      json(415, { error: "Content-Type must be application/json" });
      return;
    }

    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");

    // Parse JSON body helper
    const readBody = (): Promise<Record<string, unknown>> => {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
        req.on("error", reject);
      });
    };

    // ── Manor-control routes (/projects…, /agents, /webview/:id/*…) ──
    if (await handleControlRequest(this.getDeps(), method, url, json, readBody)) {
      return;
    }

    res.writeHead(404);
    res.end();
  }
}
