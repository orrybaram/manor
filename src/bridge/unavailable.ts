/**
 * What the browser refuses without asking the host (ADR-178 D8).
 *
 * A browser's list, and only a browser's: the desktop answers every one of
 * these out of `manorHost.native` (ADR-180 D3), so the WebSocket transport is
 * the only consumer of this file and the client's step 3 is dead code under
 * Electron.
 *
 * The bridge could let every one of these round-trip: `bridge/handlers.ts` has no
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
 * `HANDLERS` and nothing here.
 */

import type { LocalOnlyMethod } from "../../electron/bridge/local-only";

/**
 * Namespaces with no browser meaning at all.
 *
 * | namespace  | why |
 * | ---------- | --- |
 * | `webview`  | `<webview>` is Electron's; a page cannot embed *and* script arbitrary cross-origin sites (ADR-052/056/058/158) |
 * | `window`   | detach-to-window needs native chrome and survives no popup blocker (ADR-156/179 D4) |
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
const UNAVAILABLE = [
  "webview",
  "window",
  "menu",
  "dialog",
  "shell",
  "updater",
  "clipboard",
] as const;

export const UNAVAILABLE_NAMESPACES: ReadonlySet<string> = new Set(UNAVAILABLE);

/**
 * One of them, as a literal. `electron/bridge/surface.ts` reads it: a method
 * in a namespace named here needs no other placement for the web, because
 * refusing it *is* the answer (ADR-180 D7).
 */
export type UnavailableNamespace = (typeof UNAVAILABLE)[number];

/**
 * `ns.method` entries the tab answers itself.
 *
 * Two kinds, and both are here rather than in `client.ts` so that the
 * client stays a proxy, the transport stays a transport, and this file stays
 * the whole list of things the socket does not carry:
 *
 * 1. **A browser API does it better.** `clipboard.writeText` on the desktop
 *    writes to the machine's clipboard through main; from a browser the
 *    clipboard the user means is the one in front of them. (Every other call
 *    site in `src/` already reaches for `navigator.clipboard` directly.)
 * 2. **The browser's own memory.** `viewport.*` is what *this tab* was
 *    looking at (ADR-179 D3). Asking the host would be asking the wrong
 *    machine: the selection a phone remembers is the phone's, and the desk
 *    keeps its own in `~/.manor/viewport.json`. `localStorage` is exactly the
 *    right store for it, and serving it here means the store code that calls
 *    `viewport.load()` / `viewport.save()` is identical on both platforms.
 * 3. **Fire-and-forget calls with nothing to forget.** Each of these is an
 *    `ipcRenderer.send` in `preload.ts` — declared `=> void`, never awaited by
 *    its caller — answering a native surface that does not exist here. A
 *    rejected promise from a call site that ignores the return value is not an
 *    error the user can see or the code can catch; it is an unhandled
 *    rejection per keystroke. `menu.setContext` alone fires on every focus
 *    change (`useMenuContextSync`).
 */
/** Where a browser tab keeps its viewport (ADR-179 D3). */
const VIEWPORT_KEY = "manor.web.viewport";

const SERVED_HERE = {
  "clipboard.writeText": (text: unknown) =>
    navigator.clipboard?.writeText(String(text)) ??
    Promise.reject(new Error("This browser has no clipboard access")),

  /**
   * This tab's viewport. A private-mode browser with no `localStorage` reads
   * as "never saved one", which is the same answer a first visit gives, and
   * the host's default viewport covers both.
   */
  "viewport.load": () => {
    try {
      const raw = localStorage.getItem(VIEWPORT_KEY);
      return Promise.resolve(raw === null ? null : JSON.parse(raw));
    } catch {
      return Promise.resolve(null);
    }
  },
  "viewport.save": (file: unknown) => {
    try {
      localStorage.setItem(VIEWPORT_KEY, JSON.stringify(file));
    } catch {
      // Quota, private mode, a blocked third-party context: the tab simply
      // reopens on the host's default viewport.
    }
    return Promise.resolve();
  },

  /** Labels for a menu bar that is not on screen. */
  "menu.setContext": () => undefined,
  /** Moves a window that is a browser tab. */
  "window.setPosition": () => undefined,
  /** Closes a detached window; the web app is never detached. */
  "window.closeSelf": () => undefined,
  /** Forwards a command to the primary window; there is one window here. */
  "keybindings.runInMainWindow": () => undefined,

  /**
   * The prewarm pair — local-only on the table (ADR-180 D4), answered here
   * so a browser never asks.
   *
   * There is one prewarmed shell per host and its cwd follows the *primary
   * window's* workspace, so a tab has none to steer and none to adopt. That
   * alone would only make these pointless. What makes them belong here is
   * that `App.tsx` calls `updatePrewarmCwd` on every workspace change: sent to
   * the host, each one would be refused, and since refused `LOCAL_ONLY` calls
   * are audited, every browser mount would write a `rejected` line the device
   * never meant — noise in the one log whose job is to show a stolen token
   * probing for power. `consumePrewarmed` answers `null`, the
   * honest "none waiting", and its caller falls back to a fresh shell.
   */
  "pty.updatePrewarmCwd": () => Promise.resolve(),
  "pty.consumePrewarmed": () => Promise.resolve(null),
  /** Answers an `appCommands.onCommand`, which nothing on the web can deliver. */
  "appCommands.result": () => undefined,
  // `satisfies` rather than an annotation, so the keys stay literal for
  // `electron/bridge/surface.ts`: this is one of the four places a method of
  // `ElectronAPI` may be served, and the check reads it (ADR-180 D7).
} satisfies Record<string, (...args: never[]) => unknown>;

export const LOCALLY_SERVED: Record<string, (...args: unknown[]) => unknown> =
  SERVED_HERE;

/** One `ns.method` the tab answers itself. */
export type LocallyServedMethod = keyof typeof SERVED_HERE;

/** Only a local-only method may be named in `HostRefusedMethod`. */
type LocalOnly<M extends LocalOnlyMethod> = M;

/**
 * The local-only methods (`electron/bridge/local-only.ts`) the tab does *not*
 * answer itself, and why that is the right answer for them.
 *
 * Each is a key or the lock it turns, or an edit to a settings page the web
 * app shows read-only. No browser UI calls one; a call that arrives anyway is
 * somebody probing for power, and the host's `unavailable:web` — with the
 * `rejected` audit line it writes — is exactly what it should get. Every
 * other local-only method is in `SERVED_HERE`, which `surface.ts` checks.
 */
export type HostRefusedMethod = LocalOnly<
  | "keybindings.set"
  | "keybindings.reset"
  | "keybindings.resetAll"
  | "remoteControl.setEnabled"
  | "remoteControl.pair"
  | "remoteControl.revoke"
  | "remoteControl.startTunnel"
  | "remoteControl.stopTunnel"
  | "linear.connect"
>;
