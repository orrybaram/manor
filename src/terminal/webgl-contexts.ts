/**
 * WebGL for terminal panes, under a budget this window keeps itself.
 *
 * Each pane's WebGL renderer holds a context, and Chromium keeps only about 16
 * live at once: past that it drops the *oldest*, wherever it is — a pane on
 * screen as readily as one in a background tab. A pane whose context is
 * dropped falls back to xterm's DOM renderer, and used to stay there for the
 * rest of its life (issue #307).
 *
 * So the window never lets Chromium choose. It holds at most
 * {@link WEBGL_CONTEXT_BUDGET} contexts, below the browser's limit; a pane
 * that is shown and has none takes one, releasing the least recently shown
 * hidden pane's context first when the budget is spent. A hidden pane only
 * takes a context the budget has spare, and keeps the one it has until a shown
 * pane needs it — so ordinary tab switches under the budget recreate nothing.
 * A pane that loses its context any other way (the GPU process restarting)
 * gets it back when it is next shown, or straight away if it is shown now.
 */

import type { Terminal } from "@xterm/xterm";
import type { RenderAddons } from "./addons";

/**
 * How many WebGL contexts this window holds at most. Below Chromium's 16 so
 * that the browser's own limit is never what decides: other contexts in the
 * renderer process count against it too.
 */
export const WEBGL_CONTEXT_BUDGET = 12;

/** After a context is lost under a shown pane, when to try again — once. */
export const LOST_RETRY_MS = 1_000;

type WebglAddonCtor = NonNullable<RenderAddons["WebglAddon"]>;
type WebglAddon = InstanceType<WebglAddonCtor>;

/** One pane's claim on WebGL, for the life of its terminal. */
export interface WebglClaim {
  /** Tell the budget whether the pane is on screen. */
  setShown(shown: boolean): void;
  /** Whether the pane draws with WebGL right now. */
  readonly active: boolean;
  /** Release the context; call before disposing the terminal. */
  dispose(): void;
}

interface Entry {
  term: Terminal;
  Addon: WebglAddonCtor;
  addon: WebglAddon | null;
  /** The addon's context, to release outright rather than wait for GC. */
  gl: WebGL2RenderingContext | null;
  shown: boolean;
  /** When the pane was last shown, on {@link clock}; higher is more recent. */
  lastShown: number;
  /** The addon failed to load here: this pane stays on the DOM renderer. */
  broken: boolean;
  /** A lost context's retry is spent until the pane is shown again. */
  retried: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  onRendererChange: () => void;
}

const entries = new Set<Entry>();
let clock = 0;

function liveCount(): number {
  let n = 0;
  for (const e of entries) if (e.addon) n++;
  return n;
}

/**
 * The context of the canvas the addon just added. Asked only of canvases that
 * are new since the addon loaded, all of which already have a context — so
 * this never creates one — and a 2D canvas answers null.
 */
function webglContextAmong(
  term: Terminal,
  before: ReadonlySet<HTMLCanvasElement>,
): WebGL2RenderingContext | null {
  for (const canvas of term.element?.querySelectorAll("canvas") ?? []) {
    if (before.has(canvas)) continue;
    const gl = canvas.getContext("webgl2");
    if (gl) return gl;
  }
  return null;
}

/** Drop the entry's addon. `release` also frees a context that is still live. */
function drop(e: Entry, release: boolean) {
  const { addon, gl } = e;
  e.addon = null;
  e.gl = null;
  try {
    addon?.dispose();
  } catch {
    // ignored: the renderer is going either way
  }
  if (release && gl && !gl.isContextLost()) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** The hidden pane with a context that was shown longest ago, if any. */
function evictionCandidate(): Entry | null {
  let victim: Entry | null = null;
  for (const e of entries) {
    if (!e.addon || e.shown) continue;
    if (!victim || e.lastShown < victim.lastShown) victim = e;
  }
  return victim;
}

/** Give the entry a context if the budget allows. True when it has one. */
function attach(e: Entry, notify: boolean): boolean {
  if (e.addon) return true;
  if (e.broken) return false;
  if (liveCount() >= WEBGL_CONTEXT_BUDGET) {
    if (!e.shown) return false;
    const victim = evictionCandidate();
    if (!victim) return false;
    drop(victim, true);
    victim.onRendererChange();
  }

  const before = new Set(e.term.element?.querySelectorAll("canvas") ?? []);
  let addon: WebglAddon | null = null;
  try {
    addon = new e.Addon();
    const own = addon;
    own.onContextLoss(() => {
      if (e.addon === own) lost(e);
    });
    e.term.loadAddon(own);
  } catch (err) {
    console.warn("WebGL addon failed, using DOM renderer", err);
    try {
      addon?.dispose();
    } catch {
      // ignored
    }
    e.broken = true;
    return false;
  }
  e.addon = addon;
  e.gl = webglContextAmong(e.term, before);
  if (notify) e.onRendererChange();
  return true;
}

/** Shown panes without a context take one, most recently shown first. */
function rebalance() {
  const waiting = [...entries]
    .filter((e) => e.shown && !e.addon && !e.broken)
    .sort((a, b) => b.lastShown - a.lastShown);
  for (const e of waiting) if (!attach(e, true)) break;
}

function lost(e: Entry) {
  drop(e, false);
  e.onRendererChange();
  if (!e.shown || e.retried) return;
  e.retried = true;
  e.retryTimer = setTimeout(() => {
    e.retryTimer = null;
    if (entries.has(e) && e.shown) attach(e, true);
  }, LOST_RETRY_MS);
}

/**
 * Draw `term` with WebGL, within the window's budget. Call after `open`, where
 * the addon would otherwise be loaded; `onRendererChange` hears every later
 * swap between WebGL and the DOM renderer, which can move the cell size.
 */
export function claimWebgl(
  t: Terminal,
  Addon: WebglAddonCtor,
  options: { shown: boolean; onRendererChange?: () => void },
): WebglClaim {
  const e: Entry = {
    term: t,
    Addon,
    addon: null,
    gl: null,
    shown: options.shown,
    lastShown: options.shown ? ++clock : 0,
    broken: false,
    retried: false,
    retryTimer: null,
    onRendererChange: options.onRendererChange ?? (() => {}),
  };
  entries.add(e);
  attach(e, false);

  return {
    setShown(shown) {
      if (!entries.has(e) || e.shown === shown) return;
      e.shown = shown;
      if (!shown) {
        // A shown pane the budget turned away may take this one's context now.
        rebalance();
        return;
      }
      e.lastShown = ++clock;
      e.retried = false;
      attach(e, true);
    },
    get active() {
      return e.addon !== null;
    },
    dispose() {
      if (!entries.delete(e)) return;
      if (e.retryTimer) clearTimeout(e.retryTimer);
      drop(e, true);
      rebalance();
    },
  };
}

/** Test seam: how many contexts the window holds right now. */
export function liveWebglContexts(): number {
  return liveCount();
}
