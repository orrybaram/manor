/**
 * Element picker injection script — injected into a webview via
 * `webContents.executeJavaScript()` to provide hover-highlight + click-to-select
 * element picking UX.
 *
 * Communication back to the main process is via console.log with known prefixes:
 *   - `__MANOR_PICK__:<json>` — element selected
 *   - `__MANOR_PICK_CANCEL__` — user pressed Escape
 */

import { SYMBOLICATION_SCRIPT } from './sourcemap-symbolication';

const PICKER_IIFE = `(function() {
  // Guard against double-injection
  if (window.__manor_picker_active__) return;
  window.__manor_picker_active__ = true;

  // ── Overlay element ──────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.id = '__manor-picker-overlay__';
  overlay.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 2147483647',
    'border: 2px solid #4f8ff7',
    'background: rgba(79, 143, 247, 0.12)',
    'border-radius: 3px',
    'transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s',
    'top: -9999px',
    'left: -9999px',
    'width: 0',
    'height: 0'
  ].join('; ');
  document.body.appendChild(overlay);

  // ── Crosshair lines ──────────────────────────────────────────────────────
  var vLine = document.createElement('div');
  vLine.id = '__manor-picker-vline__';
  vLine.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 2147483646',
    'top: 0',
    'left: -9999px',
    'width: 1px',
    'height: 100vh',
    'background: rgba(79, 143, 247, 0.35)'
  ].join('; ');
  document.body.appendChild(vLine);

  var hLine = document.createElement('div');
  hLine.id = '__manor-picker-hline__';
  hLine.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 2147483646',
    'top: -9999px',
    'left: 0',
    'width: 100vw',
    'height: 1px',
    'background: rgba(79, 143, 247, 0.35)'
  ].join('; ');
  document.body.appendChild(hLine);

  var currentTarget = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Build a CSS selector path for the element */
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
      // Add nth-child if needed to disambiguate
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

  /** Extract computed styles for a subset of properties */
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

  /** Extract accessibility attributes */
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

    // Find the __reactFiber$ key
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

  // ── Event handlers ────────────────────────────────────────────────────────

  function onMouseMove(e) {
    vLine.style.left = e.clientX + 'px';
    hLine.style.top = e.clientY + 'px';
  }

  function onMouseOver(e) {
    var target = e.target;
    if (!target || target === overlay || target === vLine || target === hLine || target === document.body || target === document.documentElement) return;
    currentTarget = target;
    var rect = target.getBoundingClientRect();
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!currentTarget) {
      cleanup();
      return;
    }

    var el = currentTarget;
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

    console.log('__MANOR_PICK__:' + JSON.stringify(result));
    cleanup();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('__MANOR_PICK_CANCEL__');
      cleanup();
    }
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (vLine.parentNode) vLine.parentNode.removeChild(vLine);
    if (hLine.parentNode) hLine.parentNode.removeChild(hLine);
    currentTarget = null;
    window.__manor_picker_active__ = false;
    delete window.__manor_picker_cancel__;
  }

  // Expose cancel function so the main process can programmatically cancel
  window.__manor_picker_cancel__ = function() {
    console.log('__MANOR_PICK_CANCEL__');
    cleanup();
  };

  // ── Attach listeners (capture phase to intercept before page handlers) ────
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();`;

export const PICKER_SCRIPT = SYMBOLICATION_SCRIPT + '\n' + PICKER_IIFE;
