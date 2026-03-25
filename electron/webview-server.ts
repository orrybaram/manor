/**
 * Webview HTTP server — local API for inspecting and interacting with
 * browser webviews embedded in panes.
 *
 * Follows the same lifecycle pattern as AgentHookServer in agent-hooks.ts.
 * Listens on 127.0.0.1 only with a random port, written to a port file.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { webContents } from "electron";

interface ConsoleEntry {
  timestamp: string;
  level: "log" | "warn" | "error" | "info";
  message: string;
}

const MAX_CONSOLE_ENTRIES = 200;

const PORT_FILE = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "webview-server-port",
);

export class WebviewServer {
  private server: http.Server | null = null;
  private port = 0;
  private registry: Map<string, number>; // paneId → webContentsId
  private consoleLogs: Map<string, ConsoleEntry[]> = new Map();
  private consoleListeners: Map<string, () => void> = new Map(); // paneId → cleanup fn

  constructor(registry: Map<string, number>) {
    this.registry = registry;
  }

  get serverPort(): number {
    return this.port;
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
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      // File may not exist; ignore
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

    const listener = (_event: Electron.Event, level: number, message: string) => {
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

  /** Look up and validate webContents for a paneId */
  private getWebContents(paneId: string): { wc: Electron.WebContents } | { error: string; status: number } {
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

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const method = req.method ?? "GET";

    // JSON helper
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

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

    // ── GET /webviews ──
    if (method === "GET" && url.pathname === "/webviews") {
      const result: Array<{ paneId: string; url: string; title: string }> = [];
      for (const [paneId] of this.registry) {
        const lookup = this.getWebContents(paneId);
        if ("wc" in lookup) {
          result.push({
            paneId,
            url: lookup.wc.getURL(),
            title: lookup.wc.getTitle(),
          });
        }
      }
      json(200, result);
      return;
    }

    // ── Route: /webview/:id/* ──
    const webviewMatch = url.pathname.match(/^\/webview\/([^/]+)(?:\/(.*))?$/);
    if (!webviewMatch) {
      res.writeHead(404);
      res.end();
      return;
    }

    const paneId = decodeURIComponent(webviewMatch[1]);
    const action = webviewMatch[2] ?? "";

    const lookup = this.getWebContents(paneId);
    if ("error" in lookup) {
      json(lookup.status, { error: lookup.error });
      return;
    }
    const { wc } = lookup;

    try {
      // ── POST /webview/:id/screenshot ──
      if (method === "POST" && action === "screenshot") {
        const image = await wc.capturePage();
        json(200, { image: image.toPNG().toString("base64") });
        return;
      }

      // ── POST /webview/:id/execute-js ──
      if (method === "POST" && action === "execute-js") {
        const body = await readBody();
        const code = body.code;
        if (typeof code !== "string") {
          json(400, { error: "Missing 'code' string in request body" });
          return;
        }
        try {
          const result = await wc.executeJavaScript(code);
          json(200, { result });
        } catch (err) {
          json(400, { error: String(err) });
        }
        return;
      }

      // ── POST /webview/:id/dom ──
      if (method === "POST" && action === "dom") {
        const script = `
          (function() {
            function walk(node, depth) {
              if (depth > 15) return '';
              if (node.nodeType === 3) {
                var text = node.textContent.trim();
                return text ? text.slice(0, 200) : '';
              }
              if (node.nodeType !== 1) return '';
              var tag = node.tagName.toLowerCase();
              if (tag === 'script' || tag === 'style' || tag === 'svg') return '';
              var attrs = '';
              if (node.id) attrs += ' id="' + node.id + '"';
              if (node.className && typeof node.className === 'string')
                attrs += ' class="' + node.className.split(/\\s+/).slice(0, 5).join(' ') + '"';
              var role = node.getAttribute('role');
              if (role) attrs += ' role="' + role + '"';
              var ariaLabel = node.getAttribute('aria-label');
              if (ariaLabel) attrs += ' aria-label="' + ariaLabel + '"';
              var href = node.getAttribute('href');
              if (href) attrs += ' href="' + href.slice(0, 100) + '"';
              var children = '';
              for (var i = 0; i < node.childNodes.length; i++) {
                children += walk(node.childNodes[i], depth + 1);
              }
              return '<' + tag + attrs + '>' + children + '</' + tag + '>';
            }
            return walk(document.body, 0);
          })()
        `;
        const html = await wc.executeJavaScript(script);
        json(200, { html });
        return;
      }

      // ── POST /webview/:id/click ──
      if (method === "POST" && action === "click") {
        const body = await readBody();
        let x: number;
        let y: number;

        if (typeof body.selector === "string") {
          const rect = await wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(body.selector)});
              if (!el) return null;
              var r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          `);
          if (!rect) {
            json(404, { error: "Element not found for selector" });
            return;
          }
          x = Math.round(rect.x);
          y = Math.round(rect.y);
        } else if (typeof body.x === "number" && typeof body.y === "number") {
          x = body.x;
          y = body.y;
        } else {
          json(400, { error: "Provide 'selector' or 'x'/'y' coordinates" });
          return;
        }

        wc.sendInputEvent({ type: "mouseDown", x, y, button: "left" });
        wc.sendInputEvent({ type: "mouseUp", x, y, button: "left" });
        json(200, { ok: true });
        return;
      }

      // ── POST /webview/:id/type ──
      if (method === "POST" && action === "type") {
        const body = await readBody();
        const text = body.text;
        if (typeof text !== "string") {
          json(400, { error: "Missing 'text' string in request body" });
          return;
        }

        // If selector provided, click the element first
        if (typeof body.selector === "string") {
          const rect = await wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(body.selector)});
              if (!el) return null;
              var r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          `);
          if (!rect) {
            json(404, { error: "Element not found for selector" });
            return;
          }
          const cx = Math.round(rect.x);
          const cy = Math.round(rect.y);
          wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left" });
          wc.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left" });
        }

        // Type each character
        for (const char of text) {
          wc.sendInputEvent({ type: "char", keyCode: char });
        }
        json(200, { ok: true });
        return;
      }

      // ── POST /webview/:id/navigate ──
      if (method === "POST" && action === "navigate") {
        const body = await readBody();
        const navUrl = body.url;
        if (typeof navUrl !== "string") {
          json(400, { error: "Missing 'url' string in request body" });
          return;
        }
        await wc.loadURL(navUrl);
        json(200, { ok: true });
        return;
      }

      // ── GET /webview/:id/console-logs ──
      if (method === "GET" && action === "console-logs") {
        const entries = this.consoleLogs.get(paneId) ?? [];
        json(200, entries);
        return;
      }

      // ── GET /webview/:id/url ──
      if (method === "GET" && action === "url") {
        json(200, { url: wc.getURL() });
        return;
      }

      // Unknown action
      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error(`[webview-server] Error handling ${action}:`, err);
      json(500, { error: String(err) });
    }
  }
}
