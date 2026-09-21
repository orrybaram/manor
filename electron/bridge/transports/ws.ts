/**
 * The WebSocket transport (ADR-178 D8, ADR-180 D1).
 *
 * One multiplexed socket per web renderer, carrying the bridge's frames for
 * what `invoke` did and what `on` did, plus the PTY stream. The renderer
 * talks to the Manor server only — never to the daemon, whose token-file auth
 * was designed for a loopback caller — so everything arrives here and is
 * proxied.
 *
 * What is left in this file after ADR-180 is *the socket*: the upgrade, the
 * hello handshake, the close codes, JSON, and the id a client keeps across a
 * reconnect. What `ns.method` means, who is subscribed to what, and what
 * happens when a pane's owner changes are `bridge/server.ts`'s, because a
 * desktop window needs all three and none of this. The only thing this file
 * hands over is a `BridgeConnection`.
 *
 * **Authentication is a frame, not a URL.** The upgrade request carries no
 * token: a token in a query string is a token in a proxy log, in
 * `window.history`, and in whatever the tunnel writes down. The socket is
 * accepted, and then has five seconds to present `{"type":"hello","token":…}`
 * before it is closed. Until that frame lands the connection can do exactly
 * nothing, and `remote-control/server.ts` runs the same `DeviceVerifier` and
 * the same failed-auth backoff the HTTP path runs — one gate, two transports.
 *
 * **Only a `full` device.** The `read` and `send` tiers are defined by an
 * allowlist of routes (ADR-161), and this surface is not an allowlist: it is
 * a handler table containing the terminal. A device below `full` is closed
 * with 4403 rather than given a smaller bridge, because a smaller bridge is a
 * second surface to keep honest. Every connection this transport makes is
 * therefore `callerClass: "device"` — it is the only kind that gets in here.
 *
 * Close codes are in the application range on purpose — 4401 and 4403 read as
 * the HTTP statuses they mirror, and the client can tell "your token is wrong,
 * re-pair" from "your token is right and this tier cannot do this".
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import type { StreamEvent } from "../../terminal-host/types";
import type { IpcDeps } from "../../ipc/types";
import type { AuthenticatedDevice } from "../../remote-control/server";
import { BridgeServer, type BridgeServerOptions } from "../server";
import {
  BRIDGE_PROTOCOL_VERSION,
  readInvokeFrame,
  readSubscribeFrame,
  type BridgeConnection,
} from "../types";

/** The one path that upgrades. Anything else never reaches this file. */
export const BRIDGE_PATH = "/ws";

/** No `hello`, a bad token, or a revoked device. */
export const CLOSE_UNAUTHORIZED = 4401;
/** A valid token for a device below the `full` tier. */
export const CLOSE_FORBIDDEN = 4403;

/** How long an accepted socket may stay silent before it is closed. */
const HELLO_TIMEOUT_MS = 5_000;

/** A frame larger than this is not a frame this protocol has. */
const MAX_FRAME_BYTES = 1024 * 1024;

/** What `remote-control/server.ts` answers when asked to check a hello. */
export type BridgeAuthResult =
  | { ok: true; device: AuthenticatedDevice }
  | { ok: false; code: number };

/** The `verify + backoff + tier` decision, which lives in `server.ts`. */
export type BridgeAuthenticator = (token: unknown) => BridgeAuthResult;

/** A live socket, and the connection it became once it said hello. */
interface Socket {
  socket: WebSocket;
  /**
   * This socket's id, and so this browser's *renderer* id (ADR-179 D3): it
   * goes back in the hello reply and becomes the `BridgeConnection`'s id.
   *
   * Mutable, not `readonly`: `onHello` may replace the freshly generated id
   * with the one the client says it held before a reconnect, so long as
   * nothing live is still using it (ADR-179 ticket 4's report). A stable id
   * is what lets a selection hint addressed to "the tab that sent this"
   * still find it after a blip, and what keeps this connection's
   * `pty-attachments` viewer identity from resetting on every reconnect. It
   * is frozen into the connection at hello and never moves again.
   */
  id: string;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Null until the hello lands. An unauthenticated socket is not a caller:
   * the bridge server has never heard of it, and it can do nothing but say
   * hello or be closed.
   */
  connection: BridgeConnection | null;
}

export interface WsBridgeServerOptions extends BridgeServerOptions {
  /**
   * The host surface to feed. One is built if none is handed in, so a test
   * can stand this transport up on its own; `app-lifecycle.ts` passes the
   * shared one, because the IPC transport (D2) feeds the same registry.
   */
  server?: BridgeServer;
}

/**
 * One `JSON.stringify` per frame, not per socket (ADR-180 ticket 4).
 *
 * `BridgeServer.publish` hands the *same* frame object to every subscribed
 * connection in one synchronous loop, so a pane's output was serialised once
 * per attached browser — N stringifies for N viewers, on the hottest path in
 * the app. A one-entry memo keyed by object *identity* collapses that back to
 * once: the loop is synchronous and nothing mutates a frame after building
 * it, so the next call is either the same object or a genuinely new one. One
 * entry rather than a cache because that is the whole of the pattern; a map
 * would only be a leak.
 *
 * Deliberately here and not in `BridgeServer`: the IPC transport must not
 * serialise at all — Electron's structured clone carries the object across as
 * it is — so what a frame looks like on the wire is each transport's own
 * question.
 */
export class FrameSerialiser {
  private last: unknown = null;
  private text = "";

  of(frame: unknown): string {
    if (frame === this.last && this.last !== null) return this.text;
    this.text = JSON.stringify(frame);
    this.last = frame;
    return this.text;
  }
}

export class WsBridgeServer {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly sockets = new Set<Socket>();
  private readonly server: BridgeServer;
  /** Whether `dispose` also disposes the surface, or only this transport. */
  private readonly ownsServer: boolean;
  /** One `JSON.stringify` per frame rather than per socket. See the class. */
  private readonly json = new FrameSerialiser();

  constructor(deps: IpcDeps, options: WsBridgeServerOptions = {}) {
    this.server = options.server ?? new BridgeServer(deps, options);
    this.ownsServer = options.server === undefined;
  }

  /** Live bridge sockets. The UI's "a browser is attached" signal. */
  get size(): number {
    return this.sockets.size;
  }

  /**
   * Take over a `/ws` upgrade. The socket is accepted before it has proved
   * anything — see the header — and `authenticate` is run against the first
   * frame it sends.
   */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    authenticate: BridgeAuthenticator,
  ): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.open(ws, authenticate);
    });
  }

  /**
   * One PTY stream event, handed to the host surface.
   *
   * Forwarded rather than handled: the fan-out belongs to `BridgeServer`,
   * because every transport's connections want it. It arrives here because
   * the single `backend.pty.onEvent` subscription in `app-lifecycle.ts` is
   * wired to the transport it was written against.
   */
  handleStreamEvent(event: StreamEvent): void {
    this.server.handleStreamEvent(event);
  }

  /** Close every socket. Called from `RemoteControlServer.stop()`. */
  closeAll(): void {
    for (const entry of [...this.sockets]) {
      this.drop(entry);
      try {
        entry.socket.close(1001, "server stopping");
        entry.socket.terminate();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.sockets.clear();
  }

  /** The process is exiting; there is no restart. */
  dispose(): void {
    this.closeAll();
    this.wss.close();
    if (this.ownsServer) this.server.dispose();
  }

  private open(socket: WebSocket, authenticate: BridgeAuthenticator): void {
    const entry: Socket = {
      socket,
      id: `bridge-${randomUUID()}`,
      helloTimer: null,
      connection: null,
    };
    this.sockets.add(entry);

    entry.helloTimer = setTimeout(() => {
      // Silent for five seconds with no token is indistinguishable from a
      // scanner that opened the socket to see what answers.
      this.close(entry, CLOSE_UNAUTHORIZED, "no hello");
    }, HELLO_TIMEOUT_MS);
    entry.helloTimer.unref?.();

    socket.on("message", (raw) => {
      void this.onMessage(entry, raw.toString(), authenticate);
    });
    socket.on("close", () => this.drop(entry));
    socket.on("error", () => this.drop(entry));
  }

  private async onMessage(
    entry: Socket,
    text: string,
    authenticate: BridgeAuthenticator,
  ): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("bad");
      frame = parsed as Record<string, unknown>;
    } catch {
      this.close(entry, CLOSE_UNAUTHORIZED, "malformed frame");
      return;
    }

    const connection = entry.connection;
    if (connection === null) {
      this.onHello(entry, frame, authenticate);
      return;
    }

    switch (frame.kind) {
      case "invoke": {
        const invoke = readInvokeFrame(frame);
        if (!invoke) {
          this.send(entry, {
            id: frame.id,
            kind: "result",
            ok: false,
            error: "invoke needs a string ns and method",
            code: "bad-frame",
          });
          return;
        }
        this.send(entry, await this.server.dispatch(connection, invoke));
        return;
      }
      case "subscribe": {
        const asked = readSubscribeFrame(frame, "subscribe");
        if (asked) {
          this.server.subscribe(connection, asked.ns, asked.event, asked.key);
        }
        return;
      }
      case "unsubscribe": {
        const asked = readSubscribeFrame(frame, "unsubscribe");
        if (asked) {
          this.server.unsubscribe(connection, asked.ns, asked.event, asked.key);
        }
        return;
      }
      default:
        // Unknown kinds are ignored rather than fatal: a newer client sending
        // a frame this version does not have should degrade, not disconnect.
        return;
    }
  }

  private onHello(
    entry: Socket,
    frame: Record<string, unknown>,
    authenticate: BridgeAuthenticator,
  ): void {
    if (frame.type !== "hello") {
      this.close(entry, CLOSE_UNAUTHORIZED, "hello must come first");
      return;
    }
    const result = authenticate(frame.token);
    if (!result.ok) {
      this.close(entry, result.code, "hello rejected");
      return;
    }
    if (entry.helloTimer) {
      clearTimeout(entry.helloTimer);
      entry.helloTimer = null;
    }
    // ADR-179 ticket 4's report: a reconnecting client's id used to change
    // every time, so a selection hint addressed to the id it *used* to have
    // was simply dropped, and its `pty-attachments` viewer identity reset —
    // looking, to ownership, like a brand new viewer rather than the same one
    // resuming after a blip. Reused only when nothing live already answers to
    // it: two sockets racing to be the same renderer is worse than either of
    // them keeping the id it was just given.
    const previousId =
      typeof frame.previousId === "string" ? frame.previousId : null;
    if (previousId && !this.idIsHeld(previousId, entry)) {
      entry.id = previousId;
    }
    const device = result.device;
    entry.connection = {
      id: entry.id,
      callerClass: "device",
      deviceId: device.id,
      deviceLabel: device.label,
      send: (outgoing) => this.send(entry, outgoing),
    };
    this.server.accept(entry.connection);
    this.send(entry, {
      type: "hello",
      ok: true,
      v: BRIDGE_PROTOCOL_VERSION,
      rendererId: entry.id,
    });
  }

  private idIsHeld(id: string, exclude: Socket): boolean {
    for (const entry of this.sockets) {
      if (entry !== exclude && entry.id === id) return true;
    }
    return false;
  }

  private send(entry: Socket, frame: unknown): void {
    if (entry.socket.readyState !== WebSocket.OPEN) return;
    try {
      entry.socket.send(this.json.of(frame));
    } catch {
      // A socket that died between the readyState check and the send is a
      // socket the 'close' handler is about to clean up.
    }
  }

  private close(entry: Socket, code: number, reason: string): void {
    this.drop(entry);
    try {
      entry.socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private drop(entry: Socket): void {
    if (entry.helloTimer) {
      clearTimeout(entry.helloTimer);
      entry.helloTimer = null;
    }
    const wasConnected = this.sockets.delete(entry);
    if (wasConnected && entry.connection !== null) {
      this.server.drop(entry.connection.id);
    }
  }
}
