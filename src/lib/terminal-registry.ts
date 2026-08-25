/**
 * A window-visible handle on each pane's live terminal, for tests.
 *
 * xterm draws into a WebGL canvas, so a test driving the real app has no way
 * to read what a pane actually holds — the DOM is empty, and the daemon's
 * scrollback is the byte stream rather than the grid it landed in. This is the
 * seam that makes the grid readable: the terminal itself, and the serializer
 * already loaded onto it.
 *
 * Everything a test wants to *watch* is public API on that terminal —
 * `onResize` for the grid moving, `buffer` and the serializer for its contents
 * — so this deliberately records nothing itself. Instrumentation that pushes
 * into the app is instrumentation the app has to carry.
 *
 * Registration is unconditional rather than dev-gated, because what tests
 * measure here are races, and gating changes the timing that produces them.
 */

import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

export interface TerminalHandle {
  term: Terminal;
  serialize: SerializeAddon;
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

export function registerTerminal(paneId: string, handle: TerminalHandle): void {
  registry().set(paneId, handle);
}

export function unregisterTerminal(paneId: string): void {
  registry().delete(paneId);
}
