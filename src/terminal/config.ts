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

const DEFAULT_FONT_SIZE = 13;

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
