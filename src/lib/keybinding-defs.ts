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
  defaultCombo: KeyCombo;
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
      defaultCombo: { ...def.defaultCombo },
    }));
  }

  return DEFAULT_KEYBINDINGS.map((def) => ({
    ...def,
    defaultCombo: {
      ...def.defaultCombo,
      meta: false,
      ctrl: def.defaultCombo.meta ? true : def.defaultCombo.ctrl,
    },
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
    defaults[def.id] = def.defaultCombo;
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
