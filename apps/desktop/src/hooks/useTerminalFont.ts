import { usePreferencesStore } from "../store/preferences-store";
import { isWebApp } from "../lib/platform";
import {
  clampFontSize,
  DEFAULT_FONT_SIZE,
  terminalFontFamily,
} from "../terminal/config";

/** The font a terminal draws with: a full CSS stack and a size in px. */
export interface TerminalFont {
  family: string;
  size: number;
}

/**
 * The terminal font from preferences, or the bundled default in a phone or
 * browser tab: the preference is the desktop's, and a font installed on the
 * desktop is rarely installed there.
 */
export function resolveTerminalFont(
  family: string,
  size: unknown,
  web: boolean,
): TerminalFont {
  if (web) return { family: terminalFontFamily(""), size: DEFAULT_FONT_SIZE };
  return {
    family: terminalFontFamily(family),
    size: clampFontSize(size, DEFAULT_FONT_SIZE),
  };
}

export function useTerminalFont(): TerminalFont {
  const family = usePreferencesStore((s) => s.preferences.terminalFontFamily);
  const size = usePreferencesStore((s) => s.preferences.terminalFontSize);
  return resolveTerminalFont(family ?? "", size, isWebApp());
}
