/**
 * useTerminalHotkeys — custom key event handler for xterm.
 *
 * Intercepts app-level shortcuts before the terminal swallows them,
 * and re-dispatches them on window for the app to handle.
 *
 * The set of intercepted keys is derived dynamically from the keybindings store,
 * so user-customized shortcuts are correctly intercepted.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useKeybindingsStore } from "../store/keybindings-store";
import { comboFromEvent, comboMatches } from "../lib/keybindings";

export function useTerminalHotkeys() {
  const bindingsRef = useRef(useKeybindingsStore.getState().bindings);

  // Keep ref up to date
  useEffect(() => {
    return useKeybindingsStore.subscribe((s) => {
      bindingsRef.current = s.bindings;
    });
  }, []);

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

        // No modifier? Let terminal handle it
        if (!e.metaKey && !e.ctrlKey && !e.altKey) return true;

        // Check if this combo matches any app keybinding
        const combo = comboFromEvent(e);
        const bindings = bindingsRef.current;
        for (const bound of Object.values(bindings)) {
          if (comboMatches(combo, bound)) {
            return false; // Let it bubble to window
          }
        }

        return true;
      });
    },
    [],
  );

  return { attachHandler };
}
