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

// Helper to create a meta-based combo (macOS convention)
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
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    defaultCombo: metaCombo("\\"),
    category: "app",
  },
  {
    id: "new-task",
    label: "New Task",
    defaultCombo: metaCombo("n"),
    category: "workspace",
  },
  {
    id: "new-workspace",
    label: "New Workspace",
    defaultCombo: metaCombo("n", true),
    category: "workspace",
  },
  // select-tab-1 through select-tab-9
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
export function platformDefaults(platform?: string): KeybindingDef[] {
  const resolvedPlatform =
    platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const isMac = resolvedPlatform.toLowerCase().includes("mac");

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

/** Returns true if two KeyCombos are an exact match. */
export function comboMatches(a: KeyCombo, b: KeyCombo): boolean {
  return (
    a.key === b.key &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/** Extracts a KeyCombo from a DOM KeyboardEvent. */
export function comboFromEvent(e: KeyboardEvent): KeyCombo {
  return {
    key: e.key,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/**
 * Renders a human-readable display string for a KeyCombo.
 * On mac: ⌘⇧D
 * On other: Ctrl+Shift+D
 */
export function formatCombo(
  combo: KeyCombo,
  platform: "mac" | "other",
): string {
  if (platform === "mac") {
    const parts: string[] = [];
    if (combo.ctrl) parts.push("⌃");
    if (combo.alt) parts.push("⌥");
    if (combo.shift) parts.push("⇧");
    if (combo.meta) parts.push("⌘");
    parts.push(combo.key.toUpperCase());
    return parts.join("");
  } else {
    const parts: string[] = [];
    if (combo.ctrl) parts.push("Ctrl");
    if (combo.alt) parts.push("Alt");
    if (combo.shift) parts.push("Shift");
    if (combo.meta) parts.push("Meta");
    parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return parts.join("+");
  }
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
  // The key is the last part; modifiers are everything before it
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
