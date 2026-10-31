import type { ITerminalOptions } from "@xterm/xterm";
import type { Theme } from "../store/theme-store";

/** Nerd Font fallback chain */
export const FONT_FAMILY = [
  "'MesloLGM Nerd Font Mono'",
  "'MesloLGS Nerd Font Mono'",
  "'FiraCode Nerd Font'",
  "'JetBrainsMono Nerd Font'",
  "'Hack Nerd Font'",
  "'CaskaydiaCove Nerd Font'",
  "'DroidSansMono Nerd Font'",
  "monospace",
].join(", ");

export const DEFAULT_FONT_SIZE = 13;

/** The range a font size preference is held to, terminal and editor alike. */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/** `size` held to {@link FONT_SIZE_MIN}–{@link FONT_SIZE_MAX}, or `fallback` if it is not a number. */
export function clampFontSize(size: unknown, fallback: number): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return fallback;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

/**
 * The terminal's font stack with `family` in front, or the bundled stack alone
 * for an empty one. The bundled Meslo stays behind the chosen font so the
 * glyphs it lacks, Nerd Font icons above all, still draw.
 */
export function terminalFontFamily(family: string): string {
  const name = family.replace(/["\\]/g, "").trim();
  return name ? `"${name}", ${FONT_FAMILY}` : FONT_FAMILY;
}

export function terminalOptions(
  overrides: Partial<ITerminalOptions> = {},
): ITerminalOptions {
  return {
    fontFamily: FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    macOptionIsMeta: false,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
    scrollback: 10_000,
    ...overrides,
  };
}

export function themeToXterm(t: Theme) {
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  };
}
