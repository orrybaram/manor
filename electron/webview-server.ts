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
import { PICKER_SCRIPT } from "./picker-script";
import { SYMBOLICATION_SCRIPT } from "./sourcemap-symbolication";

interface ConsoleEntry {
  timestamp: string;
  level: "log" | "warn" | "error" | "info";
  message: string;
}

const MAX_CONSOLE_ENTRIES = 200;

/** Capture a cropped region of the webview, clamped to viewport bounds. */
async function captureElementRegion(
  wc: Electron.WebContents,
  boundingBox: { x: number; y: number; width: number; height: number },
): Promise<string> {
  // Multiply by zoom factor for correct capture region
  const zoomFactor = wc.getZoomFactor();

  const rawX = boundingBox.x * zoomFactor;
  const rawY = boundingBox.y * zoomFactor;
  const rawW = boundingBox.width * zoomFactor;
  const rawH = boundingBox.height * zoomFactor;

  // Clamp origin to non-negative values
  const x = Math.max(0, Math.round(rawX));
  const y = Math.max(0, Math.round(rawY));
  const width = Math.max(1, Math.round(rawW));
  const height = Math.max(1, Math.round(rawH));

  const image = await wc.capturePage({ x, y, width, height });
  return image.toPNG().toString("base64");
}

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
  private getWebContents(
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
          wc.sendInputEvent({
            type: "mouseDown",
            x: cx,
            y: cy,
            button: "left",
          });
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

      // ── POST /webview/:id/pick-element ──
      if (method === "POST" && action === "pick-element") {
        const PICK_TIMEOUT_MS = 30_000;

        const result = await new Promise<unknown>((resolve, reject) => {
          let settled = false;

          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            wc.off("console-message", listener);
            reject(new Error("pick-element timed out after 30s"));
          }, PICK_TIMEOUT_MS);

          const listener = (
            _event: Electron.Event,
            _level: number,
            message: string,
          ) => {
            if (settled) return;

            if (message.startsWith("__MANOR_PICK__:")) {
              settled = true;
              clearTimeout(timer);
              wc.off("console-message", listener);
              try {
                resolve(JSON.parse(message.slice("__MANOR_PICK__:".length)));
              } catch {
                reject(new Error("Failed to parse pick result JSON"));
              }
            } else if (message === "__MANOR_PICK_CANCEL__") {
              settled = true;
              clearTimeout(timer);
              wc.off("console-message", listener);
              resolve({ cancelled: true });
            }
          };

          wc.on("console-message", listener);

          // Inject the picker script; ignore return value
          wc.executeJavaScript(PICKER_SCRIPT).catch((err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wc.off("console-message", listener);
            reject(err);
          });
        });

        // If the result has a bounding box, capture a cropped screenshot
        if (
          result !== null &&
          typeof result === "object" &&
          "boundingBox" in result &&
          result.boundingBox !== null &&
          typeof result.boundingBox === "object"
        ) {
          const bb = result.boundingBox as {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          const screenshot = await captureElementRegion(wc, bb);
          json(200, { ...result, screenshot });
        } else {
          json(200, result);
        }
        return;
      }

      // ── POST /webview/:id/element-context ──
      if (method === "POST" && action === "element-context") {
        const body = await readBody();
        const selector = body.selector;
        if (typeof selector !== "string") {
          json(400, { error: "Missing 'selector' string in request body" });
          return;
        }

        const extractScript = SYMBOLICATION_SCRIPT + '\n' + `(async function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;

          function getSelectorPath(el) {
            var parts = [];
            var node = el;
            while (node && node.nodeType === 1) {
              var seg = node.tagName.toLowerCase();
              if (node.id) {
                seg += '#' + CSS.escape(node.id);
                parts.unshift(seg);
                break;
              }
              if (node.className && typeof node.className === 'string') {
                var classes = node.className.trim().split(/\\s+/).slice(0, 3);
                seg += classes.map(function(c) { return '.' + CSS.escape(c); }).join('');
              }
              var parent = node.parentElement;
              if (parent) {
                var siblings = Array.from(parent.children).filter(function(s) {
                  return s.tagName === node.tagName;
                });
                if (siblings.length > 1) {
                  var idx = siblings.indexOf(node) + 1;
                  seg += ':nth-child(' + idx + ')';
                }
              }
              parts.unshift(seg);
              node = parent;
            }
            return parts.join(' > ');
          }

          function getComputedStyleSubset(el) {
            var props = [
              'color', 'background', 'font-size', 'font-family',
              'padding', 'margin', 'display', 'position', 'width', 'height'
            ];
            var computed = window.getComputedStyle(el);
            var result = {};
            for (var i = 0; i < props.length; i++) {
              result[props[i]] = computed.getPropertyValue(props[i]);
            }
            return result;
          }

          function getA11yAttributes(el) {
            var attrs = {};
            var names = ['role', 'aria-label', 'aria-level', 'tabindex'];
            for (var i = 0; i < names.length; i++) {
              var val = el.getAttribute(names[i]);
              if (val != null) {
                attrs[names[i]] = val;
              }
            }
            return attrs;
          }

          /** Returns true if the fileName looks like a bundle path that needs symbolication */
          function looksLikeBundlePath(fileName) {
            if (!fileName || typeof fileName !== 'string') return false;
            return /\\/_next\\//.test(fileName) || /\\/chunks\\//.test(fileName) || /\\.js$/.test(fileName);
          }

          /** Attempt to extract React fiber info (async — may symbolicate stack frames) */
          async function getReactFiberInfo(el) {
            var sym = window.__manor_symbolication__;

            var fiberKey = Object.keys(el).find(function(k) {
              return k.startsWith('__reactFiber$');
            });
            if (!fiberKey) return null;
            var fiber = el[fiberKey];
            if (!fiber) return null;
            var components = [];
            var node = fiber;
            var maxDepth = 20;
            while (node && maxDepth-- > 0) {
              if (typeof node.type === 'function' || typeof node.type === 'object') {
                var name = null;
                if (typeof node.type === 'function') {
                  name = node.type.displayName || node.type.name || null;
                } else if (node.type && typeof node.type === 'object') {
                  name = node.type.displayName || node.type.name || null;
                }
                if (name) {
                  var entry = { name: name };
                  if (node._debugSource) {
                    var dsFileName = node._debugSource.fileName;
                    var dsLineNumber = node._debugSource.lineNumber;
                    // Try to symbolicate if the fileName looks like a bundle path
                    if (sym && looksLikeBundlePath(dsFileName)) {
                      try {
                        var dsResult = await sym.symbolicateFrame(dsFileName, dsLineNumber, 1);
                        if (dsResult) {
                          dsFileName = dsResult.fileName;
                          dsLineNumber = dsResult.lineNumber;
                        }
                      } catch (_e) { /* graceful fallback — keep original values */ }
                    }
                    entry.source = {
                      fileName: sym ? sym.normalizeFileName(dsFileName) : dsFileName,
                      lineNumber: dsLineNumber
                    };
                  } else if (node._debugStack) {
                    try {
                      var stackStr = typeof node._debugStack === 'string'
                        ? node._debugStack
                        : (node._debugStack.stack || String(node._debugStack));
                      var frames = stackStr.split('\\n');
                      var foundSource = false;
                      for (var fi = 0; fi < frames.length && !foundSource; fi++) {
                        var frame = frames[fi].trim();
                        var m = frame.match(/\\((?:webpack:\\/\\/\\/|[a-z]+:\\/\\/[^/]+)?(\\/[^:)]+):(\\d+):(\\d+)\\)/) ||
                                frame.match(/\\(([^:)][^:]*):(\\d+):(\\d+)\\)/);
                        if (m) {
                          var parsedFileName = m[1];
                          var parsedLine = parseInt(m[2], 10);
                          var parsedCol = parseInt(m[3], 10);
                          // Attempt symbolication
                          if (sym) {
                            try {
                              var symResult = await sym.symbolicateFrame(parsedFileName, parsedLine, parsedCol);
                              if (symResult) {
                                parsedFileName = symResult.fileName;
                                parsedLine = symResult.lineNumber;
                              }
                            } catch (_e) { /* graceful fallback */ }
                            var normalized = sym.normalizeFileName(parsedFileName);
                            if (!sym.isSourceFile(normalized)) {
                              // Skip this frame — not a user source file
                              continue;
                            }
                            parsedFileName = normalized;
                          }
                          entry.source = {
                            fileName: parsedFileName,
                            lineNumber: parsedLine
                          };
                          foundSource = true;
                        }
                      }
                    } catch (_e) { /* _debugStack shape unknown, skip */ }
                  }
                  components.push(entry);
                }
              }
              node = node.return;
            }
            return components.length > 0 ? components : null;
          }

          var rect = el.getBoundingClientRect();
          var result = {
            outerHTML: el.outerHTML.slice(0, 2000),
            selector: getSelectorPath(el),
            computedStyles: getComputedStyleSubset(el),
            boundingBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            },
            accessibility: getA11yAttributes(el)
          };

          var reactInfo = await getReactFiberInfo(el);
          if (reactInfo) {
            result.reactComponents = reactInfo;
          }

          return result;
        })()`;

        try {
          const metadata = await wc.executeJavaScript(extractScript);
          if (metadata === null) {
            json(404, { error: "Element not found for selector" });
          } else {
            const screenshot = await captureElementRegion(wc, metadata.boundingBox);
            json(200, { ...metadata, screenshot });
          }
        } catch (err) {
          json(400, { error: String(err) });
        }
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
