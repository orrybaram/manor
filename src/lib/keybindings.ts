export * from "./keybinding-defs";

import type { KeyCombo } from "./keybinding-defs";

/** The canonical platform check used for keybinding display and defaults. */
export function getPlatform(): "mac" | "other" {
  const p = typeof navigator !== "undefined" ? navigator.platform : "";
  return p.toLowerCase().includes("mac") ? "mac" : "other";
}

/**
 * Single-character keys compare case-insensitively: with Shift held (⌘⇧E, say)
 * `KeyboardEvent.key` can arrive upper-cased, while bindings store lower case.
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
