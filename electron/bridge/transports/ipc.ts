/**
 * The desktop's transport: four IPC channels (ADR-180 D2).
 *
 * A renderer window reaches the host surface the same way a paired browser
 * does — `invoke`, `subscribe`, `unsubscribe`, `event`, the frames in
 * `../types.ts` — but over Electron's IPC rather than a socket. One
 * `BridgeConnection` per window, `id` = `String(webContents.id)`, which is
 * already what `rendererId` means on the desktop (`src/electron.d.ts`), so a
 * layout command's origin and a viewport report go on naming the same thing
 * they name today.
 *
 * **Why not dial `ws://127.0.0.1:<port>` and have one transport?** ADR-178
 * D8's consequences imagined exactly that, and ADR-180 D2 overturned it. A
 * loopback listener is reachable by *any* web page on the machine, so it
 * needs its own authentication; a token to authenticate with would have to
 * reach the renderer through the preload anyway, which is the boundary the
 * socket was supposed to replace. Beyond that it costs: first paint would
 * start by waiting on a connect, and every byte of PTY output would leave
 * Electron's structured clone for JSON over TCP. The protocol is the thing
 * worth sharing, not the pipe — so this file carries the same frames and
 * nothing else changes.
 *
 * **What is on this side of `BridgeConnection`.** The channel names, the
 * sender check, and the one `webContents.send` that `send(frame)` becomes.
 * What `ns.method` means, who is subscribed to what, and what to do when a
 * pane's owner changes are `../server.ts`'s, shared verbatim with the
 * WebSocket transport. That sharing is the whole of D1.
 *
 * **Authentication is being a window.** A connection from here is
 * `callerClass: "local"` — the user at the machine — so `LOCAL_ONLY` (D4)
 * lets it through and nothing it does is audited. Which makes the sender
 * check below the only door there is; see it for what it keeps out.
 *
 * **Nothing here decides what is exposed to the page.** `preload.ts` does:
 * `window.manorHost.invoke` is the only way a frame gets onto these
 * channels, and `contextIsolation` keeps the page off `ipcRenderer` itself.
 */

import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import type { IpcDeps } from "../../ipc/types";
import { BridgeServer, type BridgeServerOptions } from "../server";
import {
  readInvokeFrame,
  readSubscribeFrame,
  type BridgeConnection,
} from "../types";

/** A call, answered with its result or a `BridgeErrorEnvelope`. */
export const BRIDGE_INVOKE = "bridge:invoke";
/** `{ns, event, key?}` — start hearing this. No reply. */
export const BRIDGE_SUBSCRIBE = "bridge:subscribe";
/** `{ns, event, key?}` — stop. No reply. */
export const BRIDGE_UNSUBSCRIBE = "bridge:unsubscribe";
/** Main → renderer: one `EventFrame`. The only channel this transport sends on. */
export const BRIDGE_EVENT = "bridge:event";

/**
 * A failed invoke, as a *value*.
 *
 * `ipcMain.handle` serialises a thrown `Error` to its message and drops every
 * custom property on the way, so a rejection cannot carry the `code` that
 * tells `unavailable:web` from a real failure. Rather than smuggle the code
 * into the message and parse it back out, the failure is returned as data and
 * the client (`src/bridge/client.ts`) throws it. Honest, at the cost of one
 * shape the client has to know about.
 */
export interface BridgeErrorEnvelope {
  __bridgeError: { code: string; message: string };
}

function bridgeError(code: string, message: string): BridgeErrorEnvelope {
  return { __bridgeError: { code, message } };
}

/**
 * The reply to a frame from a sender this transport does not recognise.
 *
 * It never settles, because there is nobody to answer: an `ipcMain.handle`
 * that returns `undefined` would tell a hostile frame its call *succeeded*,
 * and one that throws would tell it the channel is there and what it thinks
 * of it. The `console.warn` at the drop site is the diagnostic — if a window
 * that should be known ever hangs on an invoke, that line says why.
 */
const NO_REPLY = new Promise<never>(() => {});

/** The little of a window this check needs. */
interface WindowLike {
  webContents: { id: number };
}

/**
 * Is this frame from one of our own renderer windows? (D2, security-critical.)
 *
 * Every frame on every channel here goes through this first. `ipcMain` is
 * process-wide: *anything* in the renderer process with an `ipcRenderer` can
 * reach these channels, and the thing to keep out is a **`<webview>` guest**
 * — a pane showing an arbitrary web page (ADR-052/056/058), whose preload is
 * not this one but whose frames arrive at the same `ipcMain`. A guest is not
 * a renderer window, so it is not in `getRendererWindows()`, so it is not
 * here, and `bridge:invoke` is the whole host surface including the terminal.
 * A gap in this function is the worst bug this ADR could ship.
 *
 * `getRendererWindows()` is the full list — the primary window plus every
 * detached one, which `registerDetachedWindow` adds to the same registry
 * before the window has loaded anything (`app-lifecycle.ts`), so a detached
 * window's first frame is never too early.
 *
 * Identity first, then id: a `BrowserWindow` hands back the same
 * `WebContents` object every time, and the id comparison is the belt to that
 * brace. Ids are unique per `WebContents` in the process and are not reused —
 * a guest gets its own.
 */
export function isRendererSender(
  sender: { id: number },
  windows: readonly WindowLike[],
): boolean {
  for (const win of windows) {
    const contents = win.webContents;
    if (contents === sender || contents.id === sender.id) return true;
  }
  return false;
}

export interface IpcBridgeTransportOptions extends BridgeServerOptions {
  /**
   * The host surface to feed. One is built if none is handed in, so a test
   * can stand this transport up alone; `app-lifecycle.ts` passes the shared
   * one, because the WebSocket transport feeds the same registry.
   */
  server?: BridgeServer;
}

/**
 * The four channels, and one connection per renderer window.
 *
 * A window's connection is made lazily, on its first frame, and dropped when
 * its `webContents` is destroyed — which releases every pane it was a viewer
 * of, exactly as a dropped socket does (`BridgeServer.drop`).
 */
export class IpcBridgeTransport {
  private readonly server: BridgeServer;
  /** Whether `dispose` also disposes the surface, or only this transport. */
  private readonly ownsServer: boolean;
  /** `webContents.id` → its connection. The registry of live windows. */
  private readonly connections = new Map<number, BridgeConnection>();
  private started = false;

  constructor(
    private readonly deps: IpcDeps,
    options: IpcBridgeTransportOptions = {},
  ) {
    this.server = options.server ?? new BridgeServer(deps, options);
    this.ownsServer = options.server === undefined;
  }

  /** Renderer windows that have spoken at least one frame. */
  get size(): number {
    return this.connections.size;
  }

  /** Listen. Idempotent: `ipcMain.handle` throws on a second registration. */
  start(): void {
    if (this.started) return;
    this.started = true;
    ipcMain.handle(BRIDGE_INVOKE, this.onInvoke);
    ipcMain.on(BRIDGE_SUBSCRIBE, this.onSubscribe);
    ipcMain.on(BRIDGE_UNSUBSCRIBE, this.onUnsubscribe);
  }

  /** The process is exiting; there is no restart. */
  dispose(): void {
    if (this.started) {
      ipcMain.removeHandler(BRIDGE_INVOKE);
      ipcMain.removeListener(BRIDGE_SUBSCRIBE, this.onSubscribe);
      ipcMain.removeListener(BRIDGE_UNSUBSCRIBE, this.onUnsubscribe);
      this.started = false;
    }
    for (const id of [...this.connections.keys()]) this.dropWindow(id);
    if (this.ownsServer) this.server.dispose();
  }

  /**
   * A call from a window. Bound as a field so `removeHandler` has the same
   * function to remove that `handle` was given.
   */
  private readonly onInvoke = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<unknown> => {
    const connection = this.connectionFor(event.sender, BRIDGE_INVOKE);
    if (!connection) return NO_REPLY;
    const frame = readInvokeFrame(asRecord(payload));
    if (!frame) {
      return bridgeError("bad-frame", "invoke needs a string ns and method");
    }
    const result = await this.server.dispatch(connection, frame);
    return result.ok ? result.result : bridgeError(result.code, result.error);
  };

  private readonly onSubscribe = (
    event: IpcMainEvent,
    payload: unknown,
  ): void => {
    const connection = this.connectionFor(event.sender, BRIDGE_SUBSCRIBE);
    if (!connection) return;
    const asked = readSubscribeFrame(asRecord(payload), "subscribe");
    if (!asked) return;
    this.server.subscribe(connection, asked.ns, asked.event, asked.key);
  };

  private readonly onUnsubscribe = (
    event: IpcMainEvent,
    payload: unknown,
  ): void => {
    const connection = this.connectionFor(event.sender, BRIDGE_UNSUBSCRIBE);
    if (!connection) return;
    const asked = readSubscribeFrame(asRecord(payload), "unsubscribe");
    if (!asked) return;
    this.server.unsubscribe(connection, asked.ns, asked.event, asked.key);
  };

  /**
   * This window's connection, making it if this is its first frame — or null
   * if the frame is not from a window of ours, which is the door in `D2`.
   */
  private connectionFor(
    sender: WebContents,
    channel: string,
  ): BridgeConnection | null {
    if (!isRendererSender(sender, this.deps.getRendererWindows())) {
      console.warn(
        `[bridge] ${channel} from an unrecognised sender (webContents ${sender.id}) — dropped`,
      );
      return null;
    }
    // Read once: `destroyed` fires with the native object already gone, and
    // `sender.id` is not there to be asked by then.
    const id = sender.id;
    const existing = this.connections.get(id);
    if (existing) return existing;

    const connection: BridgeConnection = {
      id: String(id),
      // Authenticated by being a window of this app's own making. Nothing
      // else about a local caller is recorded: there is no device, and an
      // audit line per window is the app logging itself (D4).
      callerClass: "local",
      deviceId: null,
      deviceLabel: null,
      send: (frame) => {
        // Only event frames go out on the wire here: a result is the return
        // value of `ipcMain.handle`, and `BridgeServer` never sends one this
        // way. The guard is so that a future one is dropped rather than
        // silently arriving on the event channel.
        if (frame.kind !== "event") return;
        if (sender.isDestroyed()) return;
        try {
          sender.send(BRIDGE_EVENT, frame);
        } catch {
          // The window went between the check and the send.
        }
      },
    };
    this.connections.set(id, connection);
    this.server.accept(connection);
    sender.once("destroyed", () => this.dropWindow(id));
    return connection;
  }

  /**
   * That window is gone. Dropping releases every pane it was a viewer of, so
   * a closed window stops outvoting the ones still open for a pane's winsize
   * (ADR-179 D6, ADR-180 D6).
   */
  private dropWindow(id: number): void {
    if (!this.connections.delete(id)) return;
    this.server.drop(String(id));
  }
}

/** Whatever the renderer sent, as something with properties to read. */
function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  return payload as Record<string, unknown>;
}
