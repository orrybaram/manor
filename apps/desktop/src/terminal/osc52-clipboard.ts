import type { IClipboardProvider } from "@xterm/addon-clipboard";

/**
 * Escape and other control characters a program could hide in what it
 * copies: `ESC[201~` in a paste ends bracketed paste early, so the rest
 * runs as typed. Tab and line breaks stay.
 */
const UNSAFE_IN_PASTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * OSC 52 for a pane's terminal. A program may copy to the clipboard (vim or
 * tmux over ssh), minus anything that would hijack the next paste. It may
 * never read it: the answer goes to that program's stdin, and the program
 * can be on a remote host, a pod, or reading a hostile file.
 */
export const osc52Clipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (selection, text) => {
    if (String(selection) !== "c") return;
    return navigator.clipboard.writeText(text.replace(UNSAFE_IN_PASTE, ""));
  },
};
