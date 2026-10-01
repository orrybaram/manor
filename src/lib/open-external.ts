/**
 * Opening an external URL from an imperative call site (ADR-178 ticket 9).
 *
 * `shell.openExternal` is Electron's: it hands a URL to the OS's default
 * browser through main. A browser tab has no such call, but "open this link
 * in a new tab" still means something there — `window.open` gets to the same
 * place without it. `ProjectItem.tsx` worked this out for one call site
 * (ticket 4); this is that logic, moved here so every fire-and-forget
 * `shell.openExternal(url)` — a toast action, a context-menu item, a
 * terminal link handler — routes through the one rule instead of each
 * branching on `isWebApp()` itself.
 *
 * Where the call site is rendering an anchor rather than reacting to a click
 * already handled elsewhere, prefer `<Link>` (`ui/Link/Link`) instead: a
 * plain `target="_blank"` anchor already opens correctly on both platforms
 * with no branch at all (see its own header comment).
 */

import { isWebApp } from "./platform";

export function openExternal(url: string): void {
  if (isWebApp()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void window.electronAPI.shell.openExternal(url);
}
