import type { ITerminalOptions } from "@xterm/xterm";

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

export function terminalOptions(
  overrides: Partial<ITerminalOptions> = {},
): ITerminalOptions {
  return {
    fontFamily: FONT_FAMILY,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    macOptionIsMeta: false,
    allowProposedApi: true,
    scrollback: 10_000,
    ...overrides,
  };
}
