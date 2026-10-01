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
 * **`native` is the final shape, not a shim in transit.** ADR-178 D8 named
 * the end state — the preload keeps only what only Electron can do — and
 * ADR-180 tickets 5 through 10 got there: `native` now holds exactly the
 * seven namespaces ADR-178's "what can never mirror in a browser" table
 * named from the start (`webview`, `window`, `menu`, `dialog`, `shell`,
 * `clipboard`, `updater`), and nothing else. Every other namespace the proxy
 * once fell through to here goes over `bridge:invoke` now, on every call,
 * the same as it does from a browser — 140-odd methods crossed one group at
 * a time, and this file did not have to change once for any of them.
 *
 * `native` carries no root-level function either, by the end of this ADR.
 * `onAppCommand`, `onProjectsChanged` and `sendAppCommandResult` predate the
 * namespaces around them and used to be answered straight out of this
 * object; they cross like everything else now, through `client.ts`'s
 * `ROOT_SUBSCRIPTIONS` / `ROOT_INVOKES` — an app-command is addressed to the
 * primary window's connection id (ADR-180 D5) rather than served here, and a
 * browser's `onAppCommand` still resolves to the no-op `unavailable.ts`
 * gives it, since nothing can deliver one to a tab.
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
