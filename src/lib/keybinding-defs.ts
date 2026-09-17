/**
 * The keybinding registry, split into its own leaf module with ZERO imports
 * and no DOM references so the Electron main process can import it directly
 * (to render shortcuts in the native menu) without pulling in renderer-only
 * code. `keybindings.ts` transitively references `navigator`/`KeyboardEvent`,
 * which do not exist in main. See `home-path.ts` for the precedent.
 *
 * Renderer code should keep importing these from `keybindings.ts`, which
 * re-exports everything here.
 */

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

/** A combo without ⌘ — only function keys may be bound this way (ADR-175). */
function plainCombo(key: string, shift = false): KeyCombo {
  return { key, meta: false, ctrl: false, shift, alt: false };
}

export const DEFAULT_KEYBINDINGS: KeybindingDef[] = [
  {
    id: "new-tab",
    label: "New Tab",
    defaultCombo: metaCombo("t"),
    category: "workspace",
  },
  {
    id: "close-pane",
    label: "Close Pane",
    defaultCombo: metaCombo("w"),
    category: "terminal",
  },
  {
    id: "close-tab",
    label: "Close Tab",
    defaultCombo: metaCombo("w", true),
    category: "workspace",
  },
  {
    id: "split-h",
    label: "Split Horizontal",
    defaultCombo: metaCombo("d"),
    category: "terminal",
  },
  {
    id: "split-v",
    label: "Split Vertical",
    defaultCombo: metaCombo("d", true),
    category: "terminal",
  },
  {
    id: "next-tab",
    label: "Next Tab",
    defaultCombo: metaCombo("]", true),
    category: "workspace",
  },
  {
    id: "prev-tab",
    label: "Previous Tab",
    defaultCombo: metaCombo("[", true),
    category: "workspace",
  },
  {
    id: "next-pane",
    label: "Next Pane",
    defaultCombo: metaCombo("]"),
    category: "terminal",
  },
  {
    id: "prev-pane",
    label: "Previous Pane",
    defaultCombo: metaCombo("["),
    category: "terminal",
  },
  {
    id: "history-back",
    label: "Navigate Back",
    defaultCombo: metaCombo("[", false, false, true), // Cmd+Ctrl+[
    category: "app",
  },
  {
    id: "history-forward",
    label: "Navigate Forward",
    defaultCombo: metaCombo("]", false, false, true), // Cmd+Ctrl+]
    category: "app",
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    defaultCombo: metaCombo("\\"),
    category: "app",
  },
  {
    id: "focus-sidebar",
    label: "Focus Sidebar",
    defaultCombo: metaCombo("e", true), // Cmd+Shift+E
    category: "app",
  },
  {
    id: "focus-tabbar",
    label: "Focus Tab Bar",
    defaultCombo: metaCombo("y", true), // Cmd+Shift+Y
    category: "app",
  },
  {
    id: "focus-next-region",
    label: "Focus Next Region",
    defaultCombo: plainCombo("F6"),
    category: "app",
  },
  {
    id: "focus-prev-region",
    label: "Focus Previous Region",
    defaultCombo: plainCombo("F6", true),
    category: "app",
  },
  {
    id: "new-agent",
    label: "New Agent",
    defaultCombo: metaCombo("n"),
    category: "workspace",
  },
  {
    id: "new-workspace",
    label: "New Workspace",
    defaultCombo: metaCombo("n", true),
    category: "workspace",
  },
  {
    id: "next-workspace",
    label: "Next Workspace",
    defaultCombo: metaCombo("ArrowDown", false, false, true), // Ctrl+Cmd+ArrowDown
    category: "workspace",
  },
  {
    id: "prev-workspace",
    label: "Previous Workspace",
    defaultCombo: metaCombo("ArrowUp", false, false, true), // Ctrl+Cmd+ArrowUp
    category: "workspace",
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `select-tab-${i + 1}`,
    label: `Select Tab ${i + 1}`,
    defaultCombo: metaCombo(String(i + 1)),
    category: "workspace" as KeybindingCategory,
  })),
  {
    id: "settings",
    label: "Settings",
    defaultCombo: metaCombo(","),
    category: "app",
  },
  {
    id: "command-palette",
    label: "Command Palette",
    defaultCombo: metaCombo("k"),
    category: "app",
  },
  {
    id: "new-browser",
    label: "New Browser Window",
    defaultCombo: metaCombo("b", true),
    category: "workspace",
  },
  {
    id: "browser-zoom-in",
    label: "Browser Zoom In",
    defaultCombo: metaCombo("="),
    category: "browser",
  },
  {
    id: "browser-zoom-out",
    label: "Browser Zoom Out",
    defaultCombo: metaCombo("-"),
    category: "browser",
  },
  {
    id: "browser-zoom-reset",
    label: "Browser Zoom Reset",
    defaultCombo: metaCombo("0"),
    category: "browser",
  },
  {
    id: "browser-reload",
    label: "Browser Reload",
    defaultCombo: metaCombo("r"),
    category: "browser",
  },
  {
    id: "browser-focus-url",
    label: "Focus URL Bar",
    defaultCombo: metaCombo("l"),
    category: "browser",
  },
  {
    id: "browser-back",
    label: "Browser Back",
    defaultCombo: metaCombo("["),
    category: "browser",
  },
  {
    id: "browser-forward",
    label: "Browser Forward",
    defaultCombo: metaCombo("]"),
    category: "browser",
  },
  {
    id: "browser-find",
    label: "Find in Page",
    defaultCombo: metaCombo("f"),
    category: "browser",
  },
  {
    id: "terminal-search",
    label: "Search Terminal",
    defaultCombo: metaCombo("f"),
    category: "terminal",
  },
  {
    id: "reopen-pane",
    label: "Reopen Closed Pane",
    defaultCombo: metaCombo("t", true),
    category: "workspace",
  },
  {
    id: "copy-branch",
    label: "Copy Branch Name",
    defaultCombo: metaCombo(".", true),
    category: "workspace",
  },
  {
    id: "open-diff",
    label: "Open Diff",
    defaultCombo: metaCombo("g", true), // Cmd+Shift+G
    category: "workspace",
  },
  {
    id: "split-panel-right",
    label: "Split Panel Right",
    defaultCombo: metaCombo("\\", false, true),
    category: "workspace",
  },
  {
    id: "split-panel-down",
    label: "Split Panel Down",
    defaultCombo: metaCombo("\\", true, true),
    category: "workspace",
  },
  {
    id: "focus-next-panel",
    label: "Focus Next Panel",
    defaultCombo: metaCombo("]", false, true),
    category: "workspace",
  },
  {
    id: "focus-prev-panel",
    label: "Focus Previous Panel",
    defaultCombo: metaCombo("[", false, true),
    category: "workspace",
  },
  {
    id: "open-notifications",
    label: "Open Notifications",
    // No default combo — ⌘⇧E and ⌘⇧Y are already spoken for; bind one in
    // Settings › Keybindings.
    category: "app",
  },
];

/**
 * Returns a copy of DEFAULT_KEYBINDINGS adjusted for the given platform.
 * On non-macOS platforms, `meta` is swapped to `ctrl`.
 */
export function platformDefaults(platform: string): KeybindingDef[] {
  const isMac = platform.toLowerCase().includes("mac");

  if (isMac) {
    return DEFAULT_KEYBINDINGS.map((def) => ({
      ...def,
      defaultCombo: def.defaultCombo ? { ...def.defaultCombo } : undefined,
    }));
  }

  return DEFAULT_KEYBINDINGS.map((def) => ({
    ...def,
    defaultCombo: def.defaultCombo
      ? {
          ...def.defaultCombo,
          meta: false,
          ctrl: def.defaultCombo.meta ? true : def.defaultCombo.ctrl,
        }
      : undefined,
  }));
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
): { bindings: Record<string, KeyCombo>; overriddenIds: Set<string> } {
  const defaults: Record<string, KeyCombo> = {};
  for (const def of platformDefaults(platform)) {
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
  return a.length === 1 && b.length === 1 && a.toLowerCase() === b.toLowerCase();
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
