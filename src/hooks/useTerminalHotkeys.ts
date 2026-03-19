/**
 * useTerminalHotkeys — custom key event handler for xterm.
 *
 * Intercepts app-level shortcuts (Cmd+T, Cmd+W, etc.) before the terminal
 * swallows them, and re-dispatches them on window for the app to handle.
 */

import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";

const APP_SHORTCUTS: Record<string, boolean | ((e: KeyboardEvent) => boolean)> = {
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
  "]": (e) => e.shiftKey,
  "[": (e) => e.shiftKey,
};

export function useTerminalHotkeys() {
  const attachHandler = useCallback((term: Terminal) => {
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
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
  }, []);

  return { attachHandler };
}
