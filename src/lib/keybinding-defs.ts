/**
 * The keybinding registry, split into its own leaf module with no DOM
 * references so the Electron main process can import it directly (to render
 * shortcuts in the native menu) without pulling in renderer-only code.
 * `keybindings.ts` transitively references `navigator`/`KeyboardEvent`, which
 * do not exist in main. See `home-path.ts` for the precedent. Its one import
 * is the command table, which is held to the same rule.
 *
 * Renderer code should keep importing these from `keybindings.ts`, which
 * re-exports everything here.
 */

import { COMMANDS } from "./commands";

export interface KeyCombo {
  key: string; // e.g. "t", "w", "d", ",", "[", "]", "\\", "1"-"9", "=", "-", "0"
  meta: boolean; // Cmd on mac
  ctrl: boolean; // Ctrl
  shift: boolean;
  alt: boolean;
}

export type KeybindingCategory = "app" | "workspace" | "terminal" | "browser";

export const CATEGORY_LABELS: Record<KeybindingCategory, string> = {
  app: "App",
  workspace: "Workspace",
  terminal: "Terminal",
  browser: "Browser",
};

export const CATEGORY_ORDER: KeybindingCategory[] = [
  "workspace",
  "terminal",
  "browser",
  "app",
];

export interface KeybindingDef {
  id: string;
  label: string;
  /**
   * Omitted for a command that is bindable but ships with no shortcut of its
   * own (ADR-175) — `open-notifications`, so far. `platformDefaults` and
   * `resolveBindings` leave such a command out of the resolved bindings map
   * until the user assigns one.
   */
  defaultCombo?: KeyCombo;
  category: KeybindingCategory;
}

function metaCombo(
  key: string,
  shift = false,
  alt = false,
  ctrl = false,
): KeyCombo {
  return { key, meta: true, ctrl, shift, alt };
}

/**
 * Every bindable command, in registry order — the order a combo's commands
 * are tried in. Derived from the command table (ADR-182 D10): an entry is
 * bindable when it names a `defaultCombo`, even a `null` one.
 */
export const DEFAULT_KEYBINDINGS: KeybindingDef[] = COMMANDS.flatMap(
  ({ id, label, category, defaultCombo }): KeybindingDef[] =>
    defaultCombo === undefined
      ? []
      : [{ id, label, category, ...(defaultCombo ? { defaultCombo } : {}) }],
);

/**
 * Combos a PC browser claims for itself — closing the tab, opening a new
 * one, opening a new window — before a page's own `keydown` listener ever
 * runs (ADR-181 D7). Both the ⌘ and Ctrl forms are listed: an override is
 * stored host-wide (see `resolveBindings`), so a Mac desktop user's ⌘T
 * override reaches a browser on any OS, and which form is intercepted there
 * depends on that browser's OS, not the override's origin. Exported as data
 * so the keybindings settings page can flag a stored override landing here
 * as "reserved by the browser" instead of showing a shortcut that silently
 * does something else.
 */
export const BROWSER_RESERVED_COMBOS: readonly KeyCombo[] = [
  metaCombo("w"),
  { key: "w", meta: false, ctrl: true, shift: false, alt: false },
  metaCombo("t"),
  { key: "t", meta: false, ctrl: true, shift: false, alt: false },
  metaCombo("n"),
  { key: "n", meta: false, ctrl: true, shift: false, alt: false },
];

/** Whether `combo` is one the browser claims before Manor ever sees it. */
export function isBrowserReservedCombo(combo: KeyCombo): boolean {
  return BROWSER_RESERVED_COMBOS.some((reserved) =>
    comboMatches(reserved, combo),
  );
}

/**
 * Returns a copy of DEFAULT_KEYBINDINGS adjusted for the given platform.
 * On non-macOS platforms, `meta` is swapped to `ctrl`.
 *
 * `"web"` (ADR-181 D7 — window.electronAPI.platform in a browser) is its own
 * variant: every other default is the same as on mac, but a default landing
 * on a {@link BROWSER_RESERVED_COMBOS} entry — closing the tab, opening a new
 * one, opening a new window — ships with no combo at all, since the browser
 * intercepts the key before Manor's own listener runs. Those commands stay
 * reachable from the palette and the menu; the user just has to get there
 * without the shortcut this ADR can't give them on the web.
 */
export function platformDefaults(
  platform: string,
  { inBrowser = false }: { inBrowser?: boolean } = {},
): KeybindingDef[] {
  // Being in a browser and being on a Mac are separate facts, and must stay
  // so. The OS decides ⌘ versus Ctrl; the browser only takes a few chords
  // away. An earlier version folded both into a `"web"` platform string that
  // meant "Mac-style", which handed a Windows or Linux browser ⌘ shortcuts
  // it cannot type — a regression against passing `navigator.platform`,
  // which had given it Ctrl all along.
  const isMac = platform.toLowerCase().includes("mac");

  const mapped = isMac
    ? DEFAULT_KEYBINDINGS.map((def) => ({
        ...def,
        defaultCombo: def.defaultCombo ? { ...def.defaultCombo } : undefined,
      }))
    : DEFAULT_KEYBINDINGS.map((def) => ({
        ...def,
        defaultCombo: def.defaultCombo
          ? {
              ...def.defaultCombo,
              meta: false,
              ctrl: def.defaultCombo.meta ? true : def.defaultCombo.ctrl,
            }
          : undefined,
      }));

  if (!inBrowser) return mapped;

  return mapped.map((def) =>
    def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)
      ? { ...def, defaultCombo: undefined }
      : def,
  );
}

/**
 * Produces a stable string key for a KeyCombo, suitable for storage or comparison.
 * Example: "meta+shift+d"
 */
export function serializeCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("ctrl");
  if (combo.alt) parts.push("alt");
  if (combo.shift) parts.push("shift");
  if (combo.meta) parts.push("meta");
  parts.push(combo.key);
  return parts.join("+");
}

/**
 * Parses a serialized combo string back into a KeyCombo.
 * Inverse of serializeCombo.
 */
export function deserializeCombo(s: string): KeyCombo {
  const parts = s.split("+");
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  return {
    key,
    meta: modifiers.has("meta"),
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    alt: modifiers.has("alt"),
  };
}

/**
 * Builds the merged bindings map (platform defaults + serialized overrides)
 * and the set of command IDs the user has overridden. Used by the renderer
 * keybindings store and by main to compute accelerators for the menu.
 */
export function resolveBindings(
  overrides: Record<string, string>,
  platform: string,
  opts: { inBrowser?: boolean } = {},
): { bindings: Record<string, KeyCombo>; overriddenIds: Set<string> } {
  const defaults: Record<string, KeyCombo> = {};
  for (const def of platformDefaults(platform, opts)) {
    if (def.defaultCombo) defaults[def.id] = def.defaultCombo;
  }

  const bindings = { ...defaults };
  const overriddenIds = new Set<string>();
  for (const [commandId, serialized] of Object.entries(overrides)) {
    bindings[commandId] = deserializeCombo(serialized);
    overriddenIds.add(commandId);
  }
  return { bindings, overriddenIds };
}

/** Single-character keys that pass through `comboToAccelerator` unchanged rather than upper-casing. */
const ACCELERATOR_PASSTHROUGH_KEYS = new Set(["=", "[", "]", "\\", ",", "."]);

/** Named (non single-character) keys mapped to their Electron accelerator spelling. */
const ACCELERATOR_NAMED_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Enter: "Return",
  " ": "Space",
};

/**
 * Converts a KeyCombo into Electron's accelerator string syntax
 * (e.g. "Cmd+Shift+D", "Ctrl+Cmd+Up"), for `registerAccelerator: false`
 * menu items whose shortcut is display-only.
 */
export function comboToAccelerator(
  combo: KeyCombo,
  platform: "mac" | "other",
): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.meta) parts.push(platform === "mac" ? "Cmd" : "Super");
  if (combo.shift) parts.push("Shift");

  const named = ACCELERATOR_NAMED_KEYS[combo.key];
  let key: string;
  if (named !== undefined) {
    key = named;
  } else if (
    combo.key.length === 1 &&
    !ACCELERATOR_PASSTHROUGH_KEYS.has(combo.key)
  ) {
    key = combo.key.toUpperCase();
  } else {
    key = combo.key;
  }
  parts.push(key);

  return parts.join("+");
}

// ── Pure combo matching (shared by the renderer and Electron main) ─────────

/**
 * Single-character keys compare case-insensitively: with Shift held (⌘⇧E, say)
 * the reported key can arrive upper-cased, while bindings store lower case.
 */
function keysMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return (
    a.length === 1 && b.length === 1 && a.toLowerCase() === b.toLowerCase()
  );
}

/** True for F1–F12, the only keys a binding may use without a modifier. */
export function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key);
}

/** Returns true if two KeyCombos match (modifiers exactly, letters in any case). */
export function comboMatches(a: KeyCombo, b: KeyCombo): boolean {
  return (
    keysMatch(a.key, b.key) &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/**
 * Whether a key press can be a binding at all: bindings use ⌘, Ctrl or Alt,
 * except function keys (F6 cycles focus regions), which may stand alone.
 */
export function isBindableCombo(combo: KeyCombo): boolean {
  return combo.meta || combo.ctrl || combo.alt || isFunctionKey(combo.key);
}

/** Every command bound to `combo`, in the bindings map's (registry) order. */
export function commandsForCombo(
  combo: KeyCombo,
  bindings: Record<string, KeyCombo>,
): string[] {
  if (!isBindableCombo(combo)) return [];
  const ids: string[] = [];
  for (const [commandId, bound] of Object.entries(bindings)) {
    if (comboMatches(combo, bound)) ids.push(commandId);
  }
  return ids;
}

/**
 * Browser commands a focused web page services itself (zoom and reload in
 * main, the rest relayed to the host pane on their own `webview:*` channels).
 * While a page or its URL bar has focus these beat any app command sharing the
 * combo — ⌘[ / ⌘] mean back / forward there, not previous / next pane.
 */
export const PAGE_BROWSER_COMMANDS: readonly string[] = [
  "browser-zoom-in",
  "browser-zoom-out",
  "browser-zoom-reset",
  "browser-reload",
  "browser-focus-url",
  "browser-find",
  "browser-back",
  "browser-forward",
];

/**
 * Bound commands that must never be forwarded out of a web page: they are
 * serviced deep inside another pane type, so forwarding would only swallow the
 * key.
 */
const NOT_FORWARDED_FROM_PAGE = new Set(["terminal-search"]);

/**
 * What a key pressed inside a focused web page (`<webview>` guest) should do:
 *
 * - `browser`: a {@link PAGE_BROWSER_COMMANDS} entry the page handles itself;
 * - `app`: any other bound command, forwarded to the host window;
 * - `null`: not bound — the page keeps the key.
 */
export type PageKeyAction =
  | { kind: "browser"; commandId: string }
  | { kind: "app"; commandId: string }
  | null;

export function resolvePageKey(
  combo: KeyCombo,
  bindings: Record<string, KeyCombo>,
): PageKeyAction {
  const ids = commandsForCombo(combo, bindings);
  const browser = ids.find((id) => PAGE_BROWSER_COMMANDS.includes(id));
  if (browser) return { kind: "browser", commandId: browser };
  const app = ids.find(
    (id) => !id.startsWith("browser-") && !NOT_FORWARDED_FROM_PAGE.has(id),
  );
  return app ? { kind: "app", commandId: app } : null;
}
