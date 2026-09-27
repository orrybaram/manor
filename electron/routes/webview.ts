/**
 * `/webviews`, `/recordings`, and `/webview/:paneId/*` — inspecting and
 * driving browser webviews embedded in panes (screenshots, JS execution,
 * DOM dump, click/type, navigate, recording, element picking).
 *
 * Extracted from `webview-server.ts` (ADR-183), which keeps only the HTTP
 * listener lifecycle, console-message capture, and `getWebContents` — the
 * pane→`WebContents` lookup every handler below goes through via
 * `deps.webviewPanes`, so this module never imports the `WebviewServer`
 * class itself (see `ControlDeps.webviewPanes`'s header).
 */

import * as fs from "node:fs";
import { PICKER_SCRIPT } from "../picker-script";
import { SYMBOLICATION_SCRIPT } from "../sourcemap-symbolication";
import { errorMessage } from "../lib/errors";
import {
  recordingManager,
  startRendererRecording,
  stopRecording,
  getPaneRendererWebContents,
} from "../ipc/webview";
import type { StartRecordingResult } from "../recording-manager";
import type { ControlDeps, Json, Route } from "./types";

/**
 * How long `/webview/:id/record/stop` waits for the renderer to confirm its
 * `MediaRecorder` flushed. Longer than `stopRendererRecording`'s 5s default —
 * flushing a large trailing chunk to a slow disk can take a moment, and this
 * is an explicit agent-initiated stop, not a background teardown.
 */
const RECORD_STOP_TIMEOUT_MS = 15_000;

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

/**
 * Resolve `paneId`'s `WebContents`, or answer the 503/404/410 the caller
 * should send and return `null` — the shared prelude every
 * `/webview/:paneId/*` handler below runs first.
 */
function resolveWc(
  deps: ControlDeps,
  paneId: string,
  json: Json,
): Electron.WebContents | null {
  if (!deps.webviewPanes) {
    json(503, { error: "Webview inspection is not available" });
    return null;
  }
  const lookup = deps.webviewPanes.getWebContents(paneId);
  if ("error" in lookup) {
    json(lookup.status, { error: lookup.error });
    return null;
  }
  return lookup.wc;
}

export const webviewRoutes: readonly Route[] = [
  // ── GET /webviews ──
  {
    method: "GET",
    path: "/webviews",
    async handler({ deps, json }) {
      const panes = deps.webviewPanes;
      const result: Array<{ paneId: string; url: string; title: string }> = [];
      if (panes) {
        for (const [paneId] of panes.registry) {
          const lookup = panes.getWebContents(paneId);
          if ("wc" in lookup) {
            result.push({
              paneId,
              url: lookup.wc.getURL(),
              title: lookup.wc.getTitle(),
            });
          }
        }
      }
      json(200, result);
    },
  },

  // ── GET /recordings ──
  {
    method: "GET",
    path: "/recordings",
    async handler({ json }) {
      json(200, recordingManager.list());
    },
  },

  // ── POST /webview/:paneId/screenshot ──
  {
    method: "POST",
    path: "/webview/:paneId/screenshot",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const image = await wc.capturePage();
      json(200, { image: image.toPNG().toString("base64") });
    },
  },

  // ── POST /webview/:paneId/record/start ──
  {
    method: "POST",
    path: "/webview/:paneId/record/start",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const paneId = params.paneId;
      const body = await readBody();
      const savePath = typeof body.path === "string" ? body.path : undefined;
      const maxDurationSec =
        typeof body.maxDurationSec === "number" ? body.maxDurationSec : undefined;
      const keyframeIntervalSec =
        typeof body.keyframeIntervalSec === "number"
          ? body.keyframeIntervalSec
          : undefined;

      const rendererWc = getPaneRendererWebContents(paneId);
      if (!rendererWc) {
        json(503, {
          error: "No renderer window is currently hosting this pane",
        });
        return;
      }
      const mediaSourceId = wc.getMediaSourceId(rendererWc);

      let started: StartRecordingResult;
      try {
        started = recordingManager.start({
          paneId,
          path: savePath,
          maxDurationSec,
          keyframeIntervalSec,
          capture: () => wc.capturePage().then((image) => image.toPNG().toString("base64")),
        });
      } catch (err) {
        json(409, { error: errorMessage(err) });
        return;
      }

      const renderResult = await startRendererRecording(
        started.recordingId,
        paneId,
        mediaSourceId,
      );
      if (!renderResult.ok) {
        // Roll back: a registered recording with no MediaRecorder behind it
        // would sit collecting keyframes and never produce video.
        await recordingManager.stop(started.recordingId);
        fs.promises.unlink(started.path).catch(() => {
          // Best-effort: the stream may not have flushed anything yet.
        });
        json(500, { error: renderResult.error });
        return;
      }

      // Chromium throttles rendering for hidden/occluded contents, so a
      // pane that is not the one currently in view may capture stalled or
      // black frames.
      const warning = rendererWc.isFocused()
        ? undefined
        : "Pane's window is not focused; capture may stall or produce black frames while backgrounded.";

      json(200, {
        recordingId: started.recordingId,
        path: started.path,
        ...(warning ? { warning } : {}),
      });
    },
  },

  // ── POST /webview/:paneId/record/stop ──
  {
    method: "POST",
    path: "/webview/:paneId/record/stop",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const paneId = params.paneId;
      const body = await readBody();
      const recordingId =
        typeof body.recordingId === "string"
          ? body.recordingId
          : recordingManager.list().find((r) => r.paneId === paneId)?.recordingId;

      if (!recordingId) {
        json(404, { error: "No active recording for this pane" });
        return;
      }

      const result = await stopRecording(recordingId, RECORD_STOP_TIMEOUT_MS);
      if (!result) {
        json(404, { error: `Unknown recordingId: ${recordingId}` });
        return;
      }

      json(200, {
        path: result.path,
        durationMs: result.durationMs,
        bytes: result.bytes,
        keyframes: result.keyframes,
        ...(result.alreadyStopped ? { alreadyStopped: true } : {}),
      });
    },
  },

  // ── POST /webview/:paneId/execute-js ──
  {
    method: "POST",
    path: "/webview/:paneId/execute-js",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
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
    },
  },

  // ── POST /webview/:paneId/dom ──
  {
    method: "POST",
    path: "/webview/:paneId/dom",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
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
    },
  },

  // ── POST /webview/:paneId/click ──
  {
    method: "POST",
    path: "/webview/:paneId/click",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
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
    },
  },

  // ── POST /webview/:paneId/type ──
  {
    method: "POST",
    path: "/webview/:paneId/type",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
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
    },
  },

  // ── POST /webview/:paneId/navigate ──
  {
    method: "POST",
    path: "/webview/:paneId/navigate",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const paneId = params.paneId;
      const body = await readBody();
      const navUrl = body.url;
      if (typeof navUrl !== "string") {
        json(400, { error: "Missing 'url' string in request body" });
        return;
      }
      let target: string;
      try {
        target = deps.resolvePaneUrl ? await deps.resolvePaneUrl(paneId, navUrl) : navUrl;
      } catch (err) {
        json(503, { error: errorMessage(err) });
        return;
      }
      await wc.loadURL(target);
      json(200, { ok: true });
    },
  },

  // ── POST /webview/:paneId/zoom-in | zoom-out | zoom-reset ──
  //
  // Same clamps as the `webview:zoom-*` IPC handlers: Chromium's zoom
  // level is logarithmic, so +/-0.5 is one notch and the bounds are the
  // ones the zoom menu enforces.
  {
    method: "POST",
    path: "/webview/:paneId/zoom-in",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
      json(200, { zoomLevel: wc.getZoomLevel() });
    },
  },
  {
    method: "POST",
    path: "/webview/:paneId/zoom-out",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
      json(200, { zoomLevel: wc.getZoomLevel() });
    },
  },
  {
    method: "POST",
    path: "/webview/:paneId/zoom-reset",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      wc.setZoomLevel(0);
      json(200, { zoomLevel: wc.getZoomLevel() });
    },
  },

  // ── POST /webview/:paneId/find ──
  //
  // Fire-and-forget, like the IPC handler: `findInPage` reports matches
  // through a `found-in-page` event on the webview, which the renderer's
  // find bar owns. This only drives the search.
  {
    method: "POST",
    path: "/webview/:paneId/find",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const body = await readBody();
      const query = body.query;
      if (typeof query !== "string" || !query) {
        json(400, { error: "Missing 'query' string in request body" });
        return;
      }
      const options: Electron.FindInPageOptions = {};
      if (typeof body.forward === "boolean") options.forward = body.forward;
      if (typeof body.findNext === "boolean") options.findNext = body.findNext;
      wc.findInPage(query, options);
      json(200, { ok: true });
    },
  },

  // ── POST /webview/:paneId/stop-find ──
  {
    method: "POST",
    path: "/webview/:paneId/stop-find",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      wc.stopFindInPage("clearSelection");
      json(200, { ok: true });
    },
  },

  // ── POST /webview/:paneId/mute ──
  {
    method: "POST",
    path: "/webview/:paneId/mute",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const body = await readBody();
      if (typeof body.muted !== "boolean") {
        json(400, { error: "Missing 'muted' boolean in request body" });
        return;
      }
      wc.setAudioMuted(body.muted);
      json(200, { muted: body.muted });
    },
  },

  // ── POST /webview/:paneId/stop ──
  {
    method: "POST",
    path: "/webview/:paneId/stop",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      wc.stop();
      json(200, { ok: true });
    },
  },

  // ── GET /webview/:paneId/console-logs ──
  {
    method: "GET",
    path: "/webview/:paneId/console-logs",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const entries = deps.webviewPanes?.consoleLogs.get(params.paneId) ?? [];
      json(200, entries);
    },
  },

  // ── GET /webview/:paneId/url ──
  {
    method: "GET",
    path: "/webview/:paneId/url",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      json(200, { url: wc.getURL() });
    },
  },

  // ── POST /webview/:paneId/pick-element ──
  {
    method: "POST",
    path: "/webview/:paneId/pick-element",
    async handler({ deps, params, json }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
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
    },
  },

  // ── POST /webview/:paneId/element-context ──
  {
    method: "POST",
    path: "/webview/:paneId/element-context",
    async handler({ deps, params, json, readBody }) {
      const wc = resolveWc(deps, params.paneId, json);
      if (!wc) return;
      const body = await readBody();
      const selector = body.selector;
      if (typeof selector !== "string") {
        json(400, { error: "Missing 'selector' string in request body" });
        return;
      }

      const extractScript =
        SYMBOLICATION_SCRIPT +
        "\n" +
        `(async function() {
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
    },
  },
];
