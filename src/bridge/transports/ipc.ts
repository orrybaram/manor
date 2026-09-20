/**
 * The desktop's transport: `window.manorHost` (ADR-180 D2/D3).
 *
 * The same frames the WebSocket carries, over the four `bridge:*` channels
 * the preload opens onto `electron/bridge/transports/ipc.ts`. There is no
 * socket here and so none of a socket's apparatus: IPC is up before the page
 * runs, it cannot drop while the window lives, and the preload holds the
 * subscription registry (reference-counted, because React StrictMode mounts
 * an effect twice). What is left is a thin adapter — which is the point of
 * ADR-180 D2: the protocol is the thing worth sharing, not the pipe.
 *
 * **Three things come off `manorHost` rather than the host.** The facts a
 * renderer needs before it can ask anything (`rendererId`, `isDetached`,
 * `detachedWindowId`, `claim`, `env`) are read off the preload's own argv and
 * answered synchronously, because a component branching on them is rendering.
 *
 * **`native` is the migration shim.** ADR-178 D8 promised the preload would
 * end up as the namespaces that can never leave it — `webview`, `window`,
 * `menu`, `dialog`, `shell`, `clipboard`, `updater` — and nothing else. Today
 * it is still *every* namespace, so every call the proxy makes lands back in
 * the preload and the desktop behaves exactly as it did before this file
 * existed. Each later ticket takes a group out of `native`, and each one that
 * leaves starts going over `bridge:invoke` on the very next call, with no
 * change here and none in the 97 files that call it.
 *
 * A *function* on `native` is a root-level member (`onAppCommand`,
 * `onProjectsChanged`, `sendAppCommandResult`) rather than a namespace, and
 * is served as a `locallyServed` entry with no dot in its name — the same way
 * the browser serves `sendAppCommandResult` out of `unavailable.ts`.
 */

import { UNAVAILABLE_CODE } from "../../../electron/bridge/types";
import type { BridgeErrorEnvelope, ManorHost } from "../../electron";
import {
  BridgeUnavailableError,
  type BridgeListener,
  type BridgeTransport,
} from "../client";

/**
 * A failed invoke arrives as a *value*, not a rejection.
 *
 * `ipcMain.handle` serialises a thrown `Error` to its message and drops every
 * custom property on the way, so a rejection could not carry the `code` that
 * tells `unavailable:web` from a real failure. The host returns the failure
 * as data (`electron/bridge/transports/ipc.ts`) and this is where it becomes
 * the error it should have been.
 */
function asEnvelope(
  value: unknown,
): BridgeErrorEnvelope["__bridgeError"] | null {
  if (typeof value !== "object" || value === null) return null;
  const wrapped = (value as Partial<BridgeErrorEnvelope>).__bridgeError;
  if (typeof wrapped !== "object" || wrapped === null) return null;
  const { code, message } = wrapped as { code?: unknown; message?: unknown };
  if (typeof code !== "string") return null;
  return { code, message: typeof message === "string" ? message : code };
}

/** The transport `main.tsx` hands `createBridge`. */
export function createIpcTransport(host: ManorHost): BridgeTransport {
  const locallyServed: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, value] of Object.entries(host.native)) {
    if (typeof value === "function") {
      locallyServed[name] = (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(host.native, args);
    }
  }

  return {
    /** IPC is listening before the page's first line runs. */
    start() {},
    rendererId: host.rendererId,
    platform: "electron",
    rootValues: {
      isDetached: host.isDetached,
      detachedWindowId: host.detachedWindowId,
      claim: host.claim,
      env: host.env,
    },
    localNamespaces: host.native,
    locallyServed,

    async invoke(ns, method, args) {
      const result = await host.invoke(ns, method, args);
      const failure = asEnvelope(result);
      if (!failure) return result;
      throw failure.code === UNAVAILABLE_CODE
        ? new BridgeUnavailableError(failure.message)
        : new Error(failure.message);
    },

    subscribe(
      ns: string,
      event: string,
      key: string | undefined,
      callback: BridgeListener,
    ) {
      return host.subscribe(ns, event, key ?? null, callback);
    },
  };
}
