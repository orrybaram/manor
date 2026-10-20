/**
 * The desktop's transport: `window.manorHost`.
 *
 * The same frames the WebSocket carries, over the four `bridge:*` channels
 * the preload opens onto `electron/bridge/transports/ipc.ts`. There is no
 * socket here and so none of a socket's apparatus: IPC is up before the page
 * runs, it cannot drop while the window lives, and the preload holds the
 * subscription registry (reference-counted, because React StrictMode mounts
 * an effect twice). What is left is a thin adapter — which is the point of
 * The protocol is the thing worth sharing, not the pipe.
 *
 * **Some things come off `manorHost` rather than the host.** The facts a
 * renderer needs before it can ask anything (`rendererId`, `claim`, `env`)
 * are read off the preload's own argv and answered synchronously, because a
 * component branching on them is rendering.
 *
 * **`native` is the final shape, not a shim in transit.** The preload keeps
 * only what only Electron can do: `native` holds exactly the seven
 * namespaces that can never mirror in a browser (`webview`, `window`,
 * `menu`, `dialog`, `shell`, `clipboard`, `updater`), and nothing else. Every other namespace the proxy
 * once fell through to here goes over `bridge:invoke` now, on every call,
 * the same as it does from a browser — 140-odd methods crossed one group at
 * a time, and this file did not have to change once for any of them.
 * Since then `native` has gained only what is native by the same test:
 * `hostPipe`, a window's own SSH stream to a host server, which
 * a page cannot open and main has to carry.
 *
 * `native` carries no root-level function either. Every member of
 * `ElectronAPI` that is not a host fact lives in a namespace, and every
 * namespace outside the native ones crosses to the host.
 */

import type { ManorHost } from "../../electron";
import { settleResult } from "../../../electron/bridge/settle";
import type { BridgeListener, BridgeTransport } from "../client";

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
      return settleResult(await host.invoke({ kind: "invoke", id, ns, method, args }));
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
