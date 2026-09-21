/**
 * `window.electronAPI`, installed as a side effect of being imported.
 *
 * A module of its own, and imported first by `src/main.tsx`, for one reason:
 * **the stores reach for `window.electronAPI` as they are created**, at module
 * scope. `usePreferencesStore`, `useAgentStore`, `useThemeStore`,
 * `useKeybindingsStore` and friends each call `getAll()` and subscribe inside
 * the zustand initializer, which runs the moment the module is evaluated —
 * and ES modules evaluate every static import of a module before the first
 * statement of the module itself. So a `main.tsx` that imported `./App` and
 * *then* installed the bridge would run all of that against a
 * `window.electronAPI` that did not exist yet, and because every one of those
 * calls is written `window.electronAPI?.…` they would not throw: they would
 * silently never happen, and the app would come up with no preferences, no
 * theme and no agent updates.
 *
 * The preload used to make that impossible by installing the object before
 * the page ran a line. Now that the page builds it (ADR-180 D3), the import
 * *order* in `main.tsx` is what makes it impossible — which is why this is a
 * module whose evaluation does the work, and not a function somebody has to
 * remember to call early enough.
 *
 * The browser holds the same invariant the same way: `install-web.ts` is
 * `web-main.tsx`'s copy of this module, imported first for the identical
 * reason (ADR-180 ticket 14 — the bug this file's comment used to note the
 * browser "lived with"). The two differ only in how they find their
 * transport — this one waits for the preload's `window.manorHost`,
 * `install-web.ts` reads the pairing token out of the URL fragment — never
 * in *when* they install it. If you touch one of these files, check the
 * other still answers "before any store" the same way.
 */

import { createBridge } from "./client";
import { createIpcTransport } from "./transports/ipc";

/**
 * Whether the preload ran. False means `window.manorHost` was not there, the
 * bridge could not be built, and `main.tsx` should say so rather than render
 * an app whose every call is against `undefined`.
 */
export const bridgeInstalled: boolean = (() => {
  const host = window.manorHost;
  if (!host) return false;
  window.electronAPI = createBridge(createIpcTransport(host));
  return true;
})();
