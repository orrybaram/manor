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
 * A fifth channel carries no frame: `bridge:rendererId` answers "who am I?"
 * synchronously, because the preload has to know before the page's first
 * line runs and the answer — `webContents.id` — is already in hand. The
 * channel names are `../types.ts`'s, because the preload sends on them and
 * may not import this file.
 *
 * **An invoke is answered with its `ResultFrame`**, failures included, the
 * same frame the socket sends. `ipcMain.handle` serialises a thrown `Error`
 * to its message and drops every custom property on the way, so a rejection
 * could not carry the `code` that tells `unavailable:web` from a real
 * failure; a frame is plain data and crosses whole.
 *
 * **What is on this side of `BridgeConnection`.** The channel names, the
 * sender check, the one `webContents.send` that `send(frame)` becomes, and
 * turning a window into a connection id (`connectionIdFor`, D5) — which no
 * other file may do, because "a connection is its `webContents.id`" is this
 * transport's own arrangement. What `ns.method` means, who is subscribed to
 * what, and what to do when a pane's owner changes are `../server.ts`'s,
 * shared verbatim with the WebSocket transport. That sharing is the whole of
 * D1.
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

import type { HostDeps } from "../../ipc/types";
import {
  setRendererWindowResolver,
  type RendererWindowLike,
} from "../../renderer-broadcast";
import type { BridgeServer } from "../server";
import {
  BRIDGE_EVENT,
  BRIDGE_INVOKE,
  BRIDGE_RENDERER_ID,
  BRIDGE_SUBSCRIBE,
  BRIDGE_UNSUBSCRIBE,
  type BridgeConnection,
  type ResultFrame,
} from "../types";

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

/**
 * The four channels, and one connection per renderer window.
 *
 * A window's connection is made lazily, on its first frame, and dropped when
 * its `webContents` is destroyed — which releases every pane it was a viewer
 * of, exactly as a dropped socket does (`BridgeServer.drop`).
 */
export class IpcBridgeTransport {
  /** `webContents.id` → its connection. The registry of live windows. */
  private readonly connections = new Map<number, BridgeConnection>();
  private started = false;

  /**
   * @param server The host surface to feed — shared with the WebSocket
   *   transport, and disposed by whoever built it, not by this.
   */
  constructor(
    private readonly deps: HostDeps,
    private readonly server: BridgeServer,
  ) {}

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
    ipcMain.on(BRIDGE_RENDERER_ID, this.onRendererId);
    setRendererWindowResolver(this.connectionIdFor);
  }

  /** The process is exiting; there is no restart. */
  dispose(): void {
    if (this.started) {
      ipcMain.removeHandler(BRIDGE_INVOKE);
      ipcMain.removeListener(BRIDGE_SUBSCRIBE, this.onSubscribe);
      ipcMain.removeListener(BRIDGE_UNSUBSCRIBE, this.onUnsubscribe);
      ipcMain.removeListener(BRIDGE_RENDERER_ID, this.onRendererId);
      setRendererWindowResolver(null);
      this.started = false;
    }
    for (const id of [...this.connections.keys()]) this.dropWindow(id);
  }

  /**
   * That window's connection id, or null if it has none (ADR-180 D5).
   *
   * The addressed half of the event migration — `appCommands.command` to the
   * primary window, `menu.command` to the focused one — is all "tell *that
   * one* renderer", and `BridgeServer.sendTo` wants an id rather than a
   * window. Turning one into the other is this
   * transport's private business: a connection id happens to be
   * `String(webContents.id)` today, and a send-site that spelled that out for
   * itself would be a second copy of a fact only this file should hold.
   *
   * Null when the window has never spoken a frame, which is not a hedge: a
   * connection is made lazily on a window's first `bridge:*` frame, so no
   * connection means a renderer that has not installed the bridge yet, and
   * nothing addressed to it could arrive anyway. Callers check this rather
   * than "is there a window" and get a better answer.
   *
   * Bound as a field because it is handed to `setRendererWindowResolver` as a
   * bare function.
   */
  readonly connectionIdFor = (
    win: RendererWindowLike | null | undefined,
  ): string | null => {
    if (!win) return null;
    const id = win.webContents.id;
    return this.connections.has(id) ? String(id) : null;
  };

  /**
   * A call from a window, answered with its result frame. Bound as a field so
   * `removeHandler` has the same function to remove that `handle` was given.
   *
   * The channel is the frame's kind — whatever `kind` the payload claims —
   * so a frame on `bridge:invoke` is always answered and a frame on the
   * other two never is.
   */
  private readonly onInvoke = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<ResultFrame> => {
    const connection = this.connectionFor(event.sender, BRIDGE_INVOKE);
    if (!connection) return NO_REPLY;
    const result = await this.server.receive(connection, {
      ...asRecord(payload),
      kind: "invoke",
    });
    // Never null for an invoke; the fallback is for the type.
    return result ?? NO_REPLY;
  };

  private readonly onSubscribe = (
    event: IpcMainEvent,
    payload: unknown,
  ): void => {
    const connection = this.connectionFor(event.sender, BRIDGE_SUBSCRIBE);
    if (!connection) return;
    void this.server.receive(connection, {
      ...asRecord(payload),
      kind: "subscribe",
    });
  };

  /**
   * The id this window will be known by, before it has said anything.
   *
   * Synchronous, so the sender blocks until this returns — which it does
   * without touching the connection registry: asking is not connecting, and
   * a window that never speaks a frame never gets one. An unrecognised
   * sender is answered `null` rather than left to hang, because a `sendSync`
   * with no `returnValue` set is a value the caller cannot distinguish from
   * a real one; null is the same answer the preload turns into "no id".
   */
  private readonly onRendererId = (event: IpcMainEvent): void => {
    event.returnValue = isRendererSender(
      event.sender,
      this.deps.getRendererWindows(),
    )
      ? String(event.sender.id)
      : null;
  };

  private readonly onUnsubscribe = (
    event: IpcMainEvent,
    payload: unknown,
  ): void => {
    const connection = this.connectionFor(event.sender, BRIDGE_UNSUBSCRIBE);
    if (!connection) return;
    void this.server.receive(connection, {
      ...asRecord(payload),
      kind: "unsubscribe",
    });
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
        // Only event frames go out on the channel here: a result is the
        // return value of `ipcMain.handle`, and `BridgeServer` never sends
        // one this way. The guard is so that a future one is dropped rather
        // than silently arriving on the event channel.
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
