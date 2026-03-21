/**
 * useTerminalHotkeys — custom key event handler for xterm.
 *
 * Intercepts app-level shortcuts (Cmd+T, Cmd+W, etc.) before the terminal
 * swallows them, and re-dispatches them on window for the app to handle.
 */

import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";

const APP_SHORTCUTS: Record<string, boolean | ((e: KeyboardEvent) => boolean)> =
  {
    t: true,
    k: true,
    d: true,
    D: true,
    w: true,
    W: true,
    "\\": true,
    "=": true,
    "-": true,
    "0": true,
    "1": true,
    "2": true,
    "3": true,
    "4": true,
    "5": true,
    "6": true,
    "7": true,
    "8": true,
    "9": true,
    "]": true,
    "[": true,
  };

export function useTerminalHotkeys() {
  const attachHandler = useCallback(
    (term: Terminal, ptyWrite: (data: string) => void) => {
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        // Shift+Enter: send CSI u sequence so CLI tools (e.g. Claude) can
        // distinguish it from plain Enter and treat it as a newline.
        if (
          e.key === "Enter" &&
          e.shiftKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          if (e.type === "keydown") {
            ptyWrite("\x1b[13;2u");
          }
          return false;
        }

        if (!e.metaKey) return true;

        const check = APP_SHORTCUTS[e.key];
        const isAppShortcut = typeof check === "function" ? check(e) : !!check;

        if (isAppShortcut) {
          // Return false to tell xterm not to handle this key —
          // the original event will bubble up to window where App.tsx handles it.
          return false;
        }

        return true;
      });
    },
    [],
  );

  return { attachHandler };
}
