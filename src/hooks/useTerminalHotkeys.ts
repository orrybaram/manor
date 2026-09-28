/**
 * useTerminalHotkeys — custom key event handler for xterm.
 *
 * Intercepts app-level shortcuts before the terminal swallows them,
 * and re-dispatches them on window for the app to handle.
 *
 * The set of intercepted keys is derived dynamically from the keybindings store,
 * so user-customized shortcuts are correctly intercepted.
 */

import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useKeybindingsStore } from "../store/keybindings-store";
import {
  comboFromEvent,
  comboMatches,
  isFunctionKey,
} from "../lib/keybindings";
import { isRemotePane, pasteClipboardImage } from "../lib/remote-image-paste";

export function useTerminalHotkeys(onOpenSearch?: () => void) {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // Read the latest onOpenSearch via ref — attachHandler is wired once at mount.
  const onOpenSearchRef = useRef(onOpenSearch);
  onOpenSearchRef.current = onOpenSearch;

  const attachHandler = useCallback(
    (term: Terminal, paneId: string, ptyWrite: (data: string) => void) => {
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

        // Ctrl+V on a remote pane: Claude Code binds this to image paste, but
        // it reads the clipboard of the box it runs on, which has no
        // clipboard of its own (ADR-187). Swallow every event type so xterm
        // never also sends \x16, and read remote status live — this handler
        // is wired once at mount, so a closed-over value would go stale the
        // moment the pane's host changes.
        if (
          e.key.toLowerCase() === "v" &&
          e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          isRemotePane(paneId)
        ) {
          if (e.type === "keydown") {
            void pasteClipboardImage(term, paneId, () => ptyWrite("\x16"));
          }
          return false;
        }

        // No modifier? Let terminal handle it — unless it's a function key,
        // which may be bound on its own (F6 cycles focus regions).
        if (!e.metaKey && !e.ctrlKey && !e.altKey && !isFunctionKey(e.key)) {
          return true;
        }

        // Check if this combo matches any app keybinding
        const combo = comboFromEvent(e);
        const bindings = bindingsRef.current;

        // Terminal search (cmd+f) is handled locally: open this pane's search
        // bar and swallow the key so the terminal doesn't process it.
        const searchBinding = bindings["terminal-search"];
        if (searchBinding && comboMatches(combo, searchBinding)) {
          if (e.type === "keydown") onOpenSearchRef.current?.();
          return false;
        }
        for (const [id, bound] of Object.entries(bindings)) {
          if (comboMatches(combo, bound)) {
            // Browser-only bindings should not intercept terminal input —
            // let the terminal handle these keys when a terminal is focused.
            if (id.startsWith("browser-")) continue;
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
