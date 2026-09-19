/**
 * Placeholder for `src/web/ws-bridge.ts` (ADR-178 ticket 4).
 *
 * `window.electronAPI` is 219 methods across 27 namespaces (`src/electron.d.ts`).
 * Ticket 4 replaces this with `createWsBridge`, a `Proxy` that implements the
 * real thing over the `/ws` WebSocket. Until that lands, this exists only so
 * `web-main.tsx` — and the 66 files that call into `window.electronAPI` —
 * have something to call that fails predictably instead of throwing
 * "cannot read properties of undefined".
 *
 * A `Proxy` rather than a hand-written stub of every namespace: the shape is
 * too large to keep in sync by hand, and every method here answers the same
 * way regardless of its name — reject, or (for a subscription) a no-op
 * unsubscribe.
 *
 * DELETE THIS FILE once ticket 4 ships `createWsBridge` and `web-main.tsx`
 * calls that instead.
 */

import type { ElectronAPI } from "../electron";

/** Every invoked method answers with the same, honest error. */
function unavailable(ns: string, method: string): Promise<never> {
  return Promise.reject(
    new Error(
      `web bridge not yet implemented: ${ns}.${method} (ADR-178 ticket 4)`,
    ),
  );
}

/**
 * One namespace of the stub — `pty`, `layout`, `projects`, and so on.
 *
 * A property starting with `on` is treated as a subscription (the bridge's
 * `on*` convention) and answers with a no-op unsubscribe function, so a
 * component that subscribes on mount and unsubscribes on unmount does not
 * throw either half of that pair. Everything else is called and awaited, so
 * it answers with a rejected promise.
 */
function stubNamespace(ns: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop.startsWith("on")) {
          return () => () => {};
        }
        return (..._args: unknown[]) => unavailable(ns, prop);
      },
    },
  );
}

/**
 * Build the stand-in bridge. Takes the same `{ token }` shape ticket 4's
 * `createWsBridge` will, so swapping the two is a one-line change in
 * `web-main.tsx`.
 */
export function createStubBridge(_opts: { token: string | null }): ElectronAPI {
  const known = {
    env: { isPackaged: false },
    isDetached: false,
    detachedWindowId: null,
  };
  return new Proxy(known, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return undefined;
      return stubNamespace(prop);
    },
  }) as unknown as ElectronAPI;
}
