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
 * **Some things come off `manorHost` rather than the host.** The facts a
 * renderer needs before it can ask anything (`rendererId`, `claim`, `env`)
 * are read off the preload's own argv and answered synchronously, because a
 * component branching on them is rendering.
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
 * `native` carries no root-level function either. Every member of
 * `ElectronAPI` that is not a host fact lives in a namespace, and every
 * namespace outside those seven crosses to the host.
 */

import type { ManorHost } from "../../electron";
import { settle, type BridgeListener, type BridgeTransport } from "../client";

/** The transport `main.tsx` hands `createBridge`. */
export function createIpcTransport(host: ManorHost): BridgeTransport {
  let nextId = 1;
  return {
    /** IPC is listening before the page's first line runs. */
    start() {},
    rendererId: host.rendererId,
    platform: "electron",
    rootValues: {
      claim: host.claim,
      env: host.env,
    },
    localNamespaces: host.native,
    locallyServed: {},

    async invoke(ns, method, args) {
      // The id is not needed to correlate — `ipcRenderer.invoke` does that —
      // but the frame is the same frame the socket carries.
      const id = nextId++;
      return settle(await host.invoke({ kind: "invoke", id, ns, method, args }));
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
