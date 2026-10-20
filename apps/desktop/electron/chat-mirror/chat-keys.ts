/**
 * The keystrokes the phone's chat view sends into a pane's PTY outside of
 * picker answers (`picker-keys.ts`): the TUI-menu navigation keys and the Enter that submits a prompt.
 */

/** The keystroke that submits Claude's prompt. */
export const CHAT_SUBMIT = "\r";

/** The navigation keys the phone can press in a TUI menu, as bytes. */
export const CHAT_KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
} as const;

export type ChatKey = keyof typeof CHAT_KEYS;
