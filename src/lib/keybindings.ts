export * from "./keybinding-defs";

import type { KeyCombo } from "./keybinding-defs";

/** The canonical platform check used for keybinding display and defaults. */
export function getPlatform(): "mac" | "other" {
  const p = typeof navigator !== "undefined" ? navigator.platform : "";
  return p.toLowerCase().includes("mac") ? "mac" : "other";
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

/** Maps DOM `KeyboardEvent.key` arrow names to display glyphs, e.g. "ArrowLeft" -> "←". */
const ARROW_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/**
 * Renders a human-readable display string for a KeyCombo.
 * On mac: ⌘⇧D
 * On other: Ctrl+Shift+D
 */
export function formatCombo(
  combo: KeyCombo,
  platform: "mac" | "other" = getPlatform(),
): string {
  const glyph = ARROW_GLYPHS[combo.key];
  if (platform === "mac") {
    const parts: string[] = [];
    if (combo.ctrl) parts.push("⌃");
    if (combo.alt) parts.push("⌥");
    if (combo.shift) parts.push("⇧");
    if (combo.meta) parts.push("⌘");
    parts.push(glyph ?? combo.key.toUpperCase());
    return parts.join("");
  } else {
    const parts: string[] = [];
    if (combo.ctrl) parts.push("Ctrl");
    if (combo.alt) parts.push("Alt");
    if (combo.shift) parts.push("Shift");
    if (combo.meta) parts.push("Meta");
    parts.push(
      glyph ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key),
    );
    return parts.join("+");
  }
}
