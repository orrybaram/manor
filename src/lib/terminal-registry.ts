/**
 * A window-visible handle on each pane's live terminal, for tests.
 *
 * xterm draws into a WebGL canvas, so a test driving the real app has no way
 * to read what a pane actually holds — the DOM is empty, and the daemon's
 * scrollback is the byte stream rather than the grid it landed in. This is the
 * seam that makes the grid readable: the terminal itself, and a snapshot of
 * its contents. The serializer behind the snapshot is loaded onto the
 * terminal the first time one is asked for, so a session nobody reads never
 * pays for it.
 *
 * Everything a test wants to *watch* is public API on that terminal —
 * `onResize` for the grid moving, `buffer` and the snapshot for its contents
 * — so this deliberately records nothing itself. Instrumentation that pushes
 * into the app is instrumentation the app has to carry.
 *
 * Registration is unconditional rather than dev-gated, because what tests
 * measure here are races, and gating changes the timing that produces them.
 */

import type { Terminal } from "@xterm/xterm";
import type { ISerializeOptions, SerializeAddon } from "@xterm/addon-serialize";
import { loadSerializeAddon } from "../terminal/addons";

export interface TerminalHandle {
  term: Terminal;
  /** The grid, scrollback included, as the ANSI that would redraw it. */
  serialize: (options?: ISerializeOptions) => Promise<string>;
}

declare global {
  interface Window {
    __manorTerminals?: Map<string, TerminalHandle>;
  }
}

function registry(): Map<string, TerminalHandle> {
  window.__manorTerminals ??= new Map();
  return window.__manorTerminals;
}

export function registerTerminal(paneId: string, term: Terminal): void {
  let addon: SerializeAddon | null = null;
  registry().set(paneId, {
    term,
    serialize: async (options) => {
      if (!addon) {
        const SerializeAddon = await loadSerializeAddon();
        // Another snapshot may have loaded it while this one waited.
        if (!addon) {
          addon = new SerializeAddon();
          term.loadAddon(addon);
        }
      }
      return addon.serialize(options);
    },
  });
}

export function unregisterTerminal(paneId: string): void {
  registry().delete(paneId);
}

/** A pane's live terminal, if it has one mounted. */
export function terminalFor(paneId: string): Terminal | null {
  return registry().get(paneId)?.term ?? null;
}
