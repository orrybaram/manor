/**
 * Page pins — injected into a browser pane's page with `executeJavaScript()`
 * while its notes are being collected. Picking stays armed until Escape (or
 * the pane says stop); each click reports the element, and once main has
 * taken its screenshot the pane numbers it and a pin is drawn on it.
 *
 * Everything drawn lives in a closed shadow root on a `<manor-pins>` element,
 * so the page's CSS can't reach it. Pins are fixed-position over their
 * elements, moved from `getBoundingClientRect` on scroll, resize and a
 * throttled MutationObserver; an element that leaves the DOM (and can't be
 * found again by its selector) keeps its last place, dimmed. The pane draws
 * the note popover itself, from the rects reported here.
 *
 * Reports go out as `console.debug` lines (verbose, so DevTools hides them):
 *   - `__MANOR_PIN_PICK__:<json>` — an element was clicked; `pickId` names it
 *   - `__MANOR_PIN_STOP__` — the user pressed Escape
 *   - `__MANOR_PIN_OPEN__:<id>` — a pin was clicked
 *   - `__MANOR_PINS__:<json>` — where each pin's element is now
 *
 * And `window.__manor_pins__` takes: `start()`, `stop()`, `sync(list)` (the
 * pins to show, `{ id, label }`, in order), `release(pickId)` (that pick's
 * screenshot is taken; the pins show again once no other is pending) and `setTheme(accent, bg)`.
 */

import { PICKER_HELPERS } from "./picker-script";
import { SYMBOLICATION_SCRIPT } from "./sourcemap-symbolication";

/** Console prefixes the script reports with. */
export const PIN_PICK_PREFIX = "__MANOR_PIN_PICK__:";
export const PIN_STOP_MESSAGE = "__MANOR_PIN_STOP__";
export const PIN_OPEN_PREFIX = "__MANOR_PIN_OPEN__:";
export const PINS_PREFIX = "__MANOR_PINS__:";
/** Every report starts with this; the agent-facing console log drops them. */
export const PIN_REPORT_PREFIX = "__MANOR_PIN";

const PINS_IIFE = `(function() {
  if (window.__manor_pins__) return;

${PICKER_HELPERS}

  // ── The layer ─────────────────────────────────────────────────────────────

  var host = document.createElement('manor-pins');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: block;';
  var root = host.attachShadow({ mode: 'closed' });
  var css = [
    '.layer { position: fixed; inset: 0; pointer-events: none; font: 700 10px/18px system-ui, -apple-system, sans-serif; }',
    '.hover { position: fixed; display: none; box-sizing: border-box; border: 2px solid var(--a); border-radius: 3px; background: color-mix(in srgb, var(--a) 12%, transparent); }',
    '.ring { position: fixed; box-sizing: border-box; outline: 2px solid var(--a); outline-offset: 2px; border-radius: 4px; }',
    '.pin { position: fixed; box-sizing: border-box; min-width: 18px; height: 18px; padding: 0 4px; border: 0; border-radius: 9px; background: var(--a); color: var(--b); font: inherit; text-align: center; cursor: pointer; pointer-events: auto; box-shadow: 0 0 0 2px var(--b); }',
    '.pin.gone { opacity: 0.4; }',
    '.ring.gone { display: none; }',
  ].join('\\n');
  var layer = document.createElement('div');
  layer.className = 'layer';
  var hoverBox = document.createElement('div');
  hoverBox.className = 'hover';
  layer.appendChild(hoverBox);
  // A constructed sheet, which a page's CSP doesn't apply to; an inline
  // <style> where that isn't supported.
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch (_e) {
    var style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }
  root.appendChild(layer);
  document.documentElement.appendChild(host);

  /** id → { el, selector, label, pin, ring, last } */
  var pins = {};
  var order = [];
  /** Clicked elements waiting for their screenshot and number. */
  var pending = {};
  var picking = false;
  var hoverEl = null;
  var seq = 0;
  var lastReport = '';
  /** Picks whose screenshot is still to come, each with its fallback timer: the pins stay hidden until none is left. */
  var hiddenFor = {};

  function report(prefix, payload) {
    console.debug(prefix + payload);
  }

  // ── Keeping pins on their elements ────────────────────────────────────────

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }

  function update() {
    scheduled = false;
    if (!host.isConnected) document.documentElement.appendChild(host);
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var p = pins[id];
      if (!p.el.isConnected) {
        // A re-render may have swapped the node for an identical one.
        var again = null;
        try { again = document.querySelector(p.selector); } catch (_e) {}
        if (again) p.el = again;
      }
      var gone = !p.el.isConnected;
      var r = null;
      if (!gone) {
        var b = p.el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) gone = true;
        else r = { x: b.left, y: b.top, width: b.width, height: b.height };
      }
      if (r) p.last = r;
      else r = p.last;
      p.pin.classList.toggle('gone', gone);
      p.ring.classList.toggle('gone', gone);
      if (r) {
        p.pin.style.left = Math.max(0, r.x - 9) + 'px';
        p.pin.style.top = Math.max(0, r.y - 9) + 'px';
        p.ring.style.left = r.x + 'px';
        p.ring.style.top = r.y + 'px';
        p.ring.style.width = r.width + 'px';
        p.ring.style.height = r.height + 'px';
        out.push({ id: id, x: r.x, y: r.y, width: r.width, height: r.height, gone: gone });
      }
    }
    var json = JSON.stringify({ pins: out, viewport: { width: innerWidth, height: innerHeight } });
    if (json !== lastReport) {
      lastReport = json;
      report('${PINS_PREFIX}', json);
    }
  }

  var mutationTimer = null;
  var observer = new MutationObserver(function(records) {
    // Showing and hiding the layer is ours, not the page's.
    var theirs = false;
    for (var i = 0; i < records.length; i++) {
      if (records[i].target !== host) { theirs = true; break; }
    }
    if (!theirs || mutationTimer !== null || order.length === 0) return;
    mutationTimer = setTimeout(function() { mutationTimer = null; schedule(); }, 100);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule);

  function makePin(id, el) {
    var ring = document.createElement('div');
    ring.className = 'ring';
    var pin = document.createElement('button');
    pin.className = 'pin';
    pin.setAttribute('data-pin-id', id);
    // A pin is ours: the page never hears it was pressed.
    var swallow = function(e) { e.preventDefault(); e.stopPropagation(); };
    pin.addEventListener('pointerdown', swallow);
    pin.addEventListener('mousedown', swallow);
    pin.addEventListener('mouseup', swallow);
    pin.addEventListener('click', function(e) {
      swallow(e);
      report('${PIN_OPEN_PREFIX}', id);
    });
    layer.appendChild(ring);
    layer.appendChild(pin);
    return { el: el, selector: getSelectorPath(el), label: '', pin: pin, ring: ring, last: null };
  }

  function sync(list) {
    var keep = {};
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var p = pins[item.id];
      if (!p && pending[item.id]) {
        p = pins[item.id] = makePin(item.id, pending[item.id]);
        delete pending[item.id];
      }
      if (!p) continue;
      keep[item.id] = true;
      next.push(item.id);
      if (p.label !== item.label) {
        p.label = item.label;
        p.pin.textContent = item.label;
      }
    }
    for (var j = 0; j < order.length; j++) {
      var gone = order[j];
      if (keep[gone]) continue;
      pins[gone].pin.remove();
      pins[gone].ring.remove();
      delete pins[gone];
    }
    order = next;
    lastReport = '';
    schedule();
  }

  function hideFor(pickId) {
    host.style.visibility = 'hidden';
    hiddenFor[pickId] = setTimeout(function() { release(pickId); }, 2000);
  }

  function release(pickId) {
    if (!(pickId in hiddenFor)) return;
    clearTimeout(hiddenFor[pickId]);
    delete hiddenFor[pickId];
    if (Object.keys(hiddenFor).length === 0) host.style.visibility = '';
  }

  // ── Picking ───────────────────────────────────────────────────────────────

  /**
   * While an agent's one-shot picker (\`pick_element\`) is on the page, its
   * clicks and Escape are its own: picking here stands aside until it's done.
   */
  function standingDown() {
    return !!window.__manor_picker_active__;
  }

  /** Whether \`e\` happened on a pin rather than the page. */
  function onPins(e) {
    return e.target === host || e.composedPath().indexOf(host) !== -1;
  }

  function onMouseOver(e) {
    if (standingDown()) { hoverBox.style.display = 'none'; return; }
    var target = e.target;
    if (!target || onPins(e) || target === document.body || target === document.documentElement) {
      hoverBox.style.display = 'none';
      return;
    }
    hoverEl = target;
    var rect = target.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = rect.left + 'px';
    hoverBox.style.top = rect.top + 'px';
    hoverBox.style.width = rect.width + 'px';
    hoverBox.style.height = rect.height + 'px';
  }

  /** Presses on the page are picks, not clicks: the page never sees them. */
  function swallowPress(e) {
    if (standingDown()) return;
    if (onPins(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  async function onClick(e) {
    if (standingDown()) return;
    // A pin: its own handler opens its note.
    if (onPins(e)) return;
    swallowPress(e);
    var el = hoverEl || e.target;
    if (!el || el === document.body || el === document.documentElement) return;

    var id = 'pin-' + Date.now().toString(36) + '-' + (++seq);
    pending[id] = el;
    var result = {
      pickId: id,
      outerHTML: el.outerHTML.slice(0, 2000),
      selector: getSelectorPath(el),
      computedStyles: getComputedStyleSubset(el),
      boundingBox: null,
      accessibility: getA11yAttributes(el),
      viewport: null
    };
    var reactInfo = await getReactFiberInfo(el);
    if (reactInfo) result.reactComponents = reactInfo;

    // Out of the screenshot: the hover box and every pin. Two frames, so the
    // hidden layer has painted before main captures.
    hoverBox.style.display = 'none';
    hideFor(id);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        var rect = el.getBoundingClientRect();
        result.boundingBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        result.viewport = { width: innerWidth, height: innerHeight };
        report('${PIN_PICK_PREFIX}', JSON.stringify(result));
      });
    });
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape' || standingDown()) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    stop();
    report('${PIN_STOP_MESSAGE}', '');
  }

  var PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];

  function start() {
    if (picking) return;
    picking = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    for (var i = 0; i < PRESS_EVENTS.length; i++) document.addEventListener(PRESS_EVENTS[i], swallowPress, true);
  }

  function stop() {
    if (!picking) return;
    picking = false;
    hoverEl = null;
    hoverBox.style.display = 'none';
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    for (var i = 0; i < PRESS_EVENTS.length; i++) document.removeEventListener(PRESS_EVENTS[i], swallowPress, true);
  }

  function setTheme(accent, bg) {
    if (accent) layer.style.setProperty('--a', accent);
    if (bg) layer.style.setProperty('--b', bg);
  }

  window.__manor_pins__ = { start: start, stop: stop, sync: sync, release: release, setTheme: setTheme };
})();`;

export const PINS_SCRIPT = SYMBOLICATION_SCRIPT + "\n" + PINS_IIFE;

/** A call on the page's `__manor_pins__`, or nothing if it isn't there. */
export function pinsCall(method: "start" | "stop" | "release" | "sync" | "setTheme", ...args: unknown[]): string {
  const list = args.map((a) => JSON.stringify(a)).join(", ");
  return `window.__manor_pins__ && window.__manor_pins__.${method}(${list});`;
}
