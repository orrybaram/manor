/**
 * The host surface (ADR-180 D1).
 *
 * One table of what this machine can do, one dispatcher for it, one registry
 * of who is connected, and one fan-out of everything that happens. A caller
 * reaches it as a `BridgeConnection` — today a socket from a paired device
 * (`transports/ws.ts`), and under D2 an Electron renderer window as well —
 * and this class cannot tell which, on purpose: that is the whole of D1.
 *
 * All of it was `WsBridgeServer` until ADR-180, and is lifted out of it
 * unchanged. What was removed is everything a WebSocket needs and a window
 * does not: the hello frame, the five-second timeout, the close codes, the
 * `readyState` check and JSON. A transport does those; `send(frame)` is the
 * whole of what this side asks of one.
 *
 * **Authentication is not here.** Remote control decides whether a token is
 * good and whether its device is `full`; this class never learns what a token
 * is. It is told the answer once, as a `callerClass`, and does three things
 * with it: `LOCAL_ONLY` (D4), the audit line, and handing it to the handler
 * as `ctx.caller`.
 *
 * **Subscription membership is the whole event filter.** A connection that
 * never subscribed to pane B never sees a byte of B's output, however much of
 * it the daemon produces. Nothing here decides *when* something changed:
 * `renderer-broadcast.ts` and the PTY stream do, and this class forwards.
 */

import type { HostDeps } from "../ipc/types";
import type { RemoteAuditLog } from "../remote-control/audit";
import {
  HANDLERS,
  LOCAL_ONLY,
  MUTATING,
  SECRET_FIRST_ARG,
  type BridgeHandler,
} from "./handlers";
import { BridgeServerCore } from "./server-core";

interface BridgeServerOptions {
  audit?: RemoteAuditLog;
  /** Overridable so a test can assert dispatch without a real `HostDeps`. */
  handlers?: Record<string, BridgeHandler>;
}

/**
 * The desktop's host surface: `BridgeServerCore` (`./server-core.ts`) over
 * `HostDeps` and the whole handler table (`./handlers.ts`).
 */
export class BridgeServer extends BridgeServerCore<HostDeps> {
  constructor(deps: HostDeps, options: BridgeServerOptions = {}) {
    super(deps, {
      audit: options.audit,
      table: {
        handlers: options.handlers ?? HANDLERS,
        localOnly: LOCAL_ONLY,
        mutating: MUTATING,
        secretFirstArg: SECRET_FIRST_ARG,
      },
    });
  }
}
