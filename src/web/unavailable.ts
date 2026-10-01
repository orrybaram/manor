/**
 * What the browser refuses without asking the host (ADR-178 D8).
 *
 * The bridge could let every one of these round-trip: `ws-handlers.ts` has no
 * entry for `webview.*` or `dialog.*` either, so the server would answer
 * `unavailable:web` and the client would raise the same error. The table
 * exists anyway for two reasons. A `<webview>` is not missing from the web
 * *build*, it is missing from the web — ADR-178's "what can never mirror in a
 * browser" list is a design fact, not a gap in a handler table, and a design
 * fact should not need a network round trip to state. And these are the
 * namespaces a mounting component touches on its way up: a hundred refusals
 * that never leave the tab are a hundred frames the socket does not carry
 * while the app is painting its first screen.
 *
 * Kept deliberately small. A namespace goes in here only when *no* method on
 * it could ever work in a browser; anything that is merely unimplemented today
 * stays out, so that implementing it server-side is one entry in
 * `WS_HANDLERS` and nothing here.
 */

/**
 * Namespaces with no browser meaning at all.
 *
 * | namespace  | why |
 * | ---------- | --- |
 * | `webview`  | `<webview>` is Electron's; a page cannot embed *and* script arbitrary cross-origin sites (ADR-052/056/058/158) |
 * | `window`   | detach-to-window needs native chrome and survives no popup blocker (ADR-156) |
 * | `menu`     | there is no native app menu to label (ADR-170) |
 * | `dialog`   | no native file pickers |
 * | `shell`    | no "reveal in Finder", no "open in editor" (ADR-050) |
 * | `updater`  | the tab is updated by reloading it |
 * | `clipboard`| except `writeText`, which is served locally below |
 *
 * `remoteControl` is *not* here: pairing another device from the browser is a
 * perfectly sensible thing to want, and it is absent from the handler table
 * rather than from the platform.
 */
export const UNAVAILABLE_NAMESPACES: ReadonlySet<string> = new Set([
  "webview",
  "window",
  "menu",
  "dialog",
  "shell",
  "updater",
  "clipboard",
]);

/**
 * `ns.method` entries the tab answers itself.
 *
 * Two kinds, and both are here rather than in `ws-bridge.ts` so that the
 * bridge stays a transport and this file stays the whole list of things it
 * does not carry:
 *
 * 1. **A browser API does it better.** `clipboard.writeText` on the desktop
 *    writes to the machine's clipboard through main; from a browser the
 *    clipboard the user means is the one in front of them. (Every other call
 *    site in `src/` already reaches for `navigator.clipboard` directly.)
 * 2. **Fire-and-forget calls with nothing to forget.** Each of these is an
 *    `ipcRenderer.send` in `preload.ts` — declared `=> void`, never awaited by
 *    its caller — answering a native surface that does not exist here. A
 *    rejected promise from a call site that ignores the return value is not an
 *    error the user can see or the code can catch; it is an unhandled
 *    rejection per keystroke. `menu.setContext` alone fires on every focus
 *    change (`useMenuContextSync`).
 */
export const LOCALLY_SERVED: Record<string, (...args: unknown[]) => unknown> = {
  "clipboard.writeText": (text: unknown) =>
    navigator.clipboard?.writeText(String(text)) ??
    Promise.reject(new Error("This browser has no clipboard access")),

  /** Labels for a menu bar that is not on screen. */
  "menu.setContext": () => undefined,
  /** Moves a window that is a browser tab. */
  "window.setPosition": () => undefined,
  /** Closes a detached window; the web app is never detached. */
  "window.closeSelf": () => undefined,
  /** Forwards a command to the primary window; there is one window here. */
  "keybindings.runInMainWindow": () => undefined,
  /** Answers an `onAppCommand`, which nothing on the web can deliver. */
  sendAppCommandResult: () => undefined,
};
