/**
 * Whether this window is the focused one, as main sees it.
 *
 * Not `document.hasFocus()`: under Electron that is false whenever a
 * `<webview>` pane holds focus, though the window plainly has it
 * (`electron/notifications.ts` says the same of main's own check). So the
 * desktop asks main — `BrowserWindow` `focus`/`blur`, pushed to this window
 * (`window.onFocusChanged`), plus an initial `window.isFocused()`.
 *
 * A browser has no main and no `<webview>`, so there the page's own focus is
 * the truth: window `focus`/`blur` and `visibilitychange`.
 *
 * Starts listening on first use and never stops: one window, one signal.
 */

type Listener = (focused: boolean) => void;

const listeners = new Set<Listener>();
let focused = true;
let started = false;

function set(next: boolean): void {
  if (next === focused) return;
  focused = next;
  for (const listener of [...listeners]) listener(next);
}

/** The page's own view, for a browser (and as the desktop's first guess). */
function pageFocused(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState === "hidden") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

function start(): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined") return;

  const api = window.electronAPI;
  if (api?.platform === "electron" && api.window?.onFocusChanged) {
    // Until main answers, `document.hasFocus()` is the best guess there is —
    // wrong only while a webview holds focus, which nothing has at boot.
    focused = pageFocused();
    let heard = false;
    api.window.onFocusChanged((next) => {
      heard = true;
      set(next);
    });
    void api.window
      .isFocused()
      .then((initial) => {
        // A push that landed first is newer than this answer.
        if (!heard) set(initial);
      })
      .catch(() => {
        // An old main without the handler: the pushes still arrive.
      });
    return;
  }

  focused = pageFocused();
  const recheck = () => set(pageFocused());
  window.addEventListener?.("focus", () => set(true));
  window.addEventListener?.("blur", () => set(false));
  if (typeof document !== "undefined") {
    document.addEventListener?.("visibilitychange", recheck);
  }
}

/** Whether this window is focused right now. */
export function isWindowFocused(): boolean {
  start();
  return focused;
}

/** Hear every change of this window's focus. Returns the unsubscribe. */
export function onWindowFocusChange(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
