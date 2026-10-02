/**
 * The bridge's socket transport (ADR-178 D8, ADR-180 D1, ADR-207 D2).
 *
 * One multiplexed connection per web renderer, carrying the bridge's frames
 * for what `invoke` did and what `on` did, plus the PTY stream. The renderer
 * talks to the Manor server only — never to the daemon, whose token-file auth
 * was designed for a loopback caller — so everything arrives here and is
 * proxied.
 *
 * What is left in this file after ADR-180 is *the connection*: the hello
 * handshake, the close codes, JSON, and the id a client keeps across a
 * reconnect. What `ns.method` means, who is subscribed to what, and what
 * happens when a pane's owner changes are `bridge/server.ts`'s, because a
 * desktop window needs all three and none of this. The only thing this file
 * hands over is a `BridgeConnection`.
 *
 * **What carries the frames is a `FrameSocket`.** Since ADR-207 there is no
 * listener and so no `/ws` upgrade: every connection is a relay channel that
 * `remote-control/relay-gate.ts` hands to `attach`.
 *
 * **Authentication is a frame, not a URL.** The connection is accepted, and
 * then has until its hello timeout to present `{"type":"hello","token":…}`
 * before it is closed. Until that frame lands the connection can do exactly
 * nothing, and the gate's `BridgeAuthenticator` runs the device verify and
 * the failed-auth backoff against it.
 *
 * **Every device is the same device.** There are no tiers (ADR-207 D4): a
 * paired device reaches the whole handler table, terminal included, and
 * every connection this transport makes is `callerClass: "device"`.
 *
 * Close codes are in the application range on purpose — 4401 reads as the
 * HTTP status it mirrors: "your token is wrong, re-pair". They are
 * `../types.ts`'s, because the browser reads them too.
 */

import { randomUUID } from "node:crypto";

import type { FrameSocket } from "./frame-socket";
import type { AuthenticatedDevice } from "../../remote-control/relay-gate";
import type { BridgeServer } from "../server";
import {
  BRIDGE_PROTOCOL_VERSION,
  CLOSE_UNAUTHORIZED,
  type BridgeConnection,
  type HelloReplyFrame,
} from "../types";

/** How long an accepted socket may stay silent before it is closed. */
const HELLO_TIMEOUT_MS = 5_000;

/** What `remote-control/relay-gate.ts` answers when asked to check a hello. */
export type BridgeAuthResult =
  | { ok: true; device: AuthenticatedDevice }
  | { ok: false; code: number };

/** The `verify + backoff` decision, which lives in `relay-gate.ts`. */
export type BridgeAuthenticator = (token: unknown) => BridgeAuthResult;

/** A live socket, and the connection it became once it said hello. */
interface Socket {
  socket: FrameSocket;
  /**
   * This socket's id, and so this browser's *renderer* id (ADR-179 D3): it
   * goes back in the hello reply and becomes the `BridgeConnection`'s id.
   *
   * Mutable, not `readonly`: `onHello` may replace the freshly generated id
   * with the one the client says it held before a reconnect, so long as
   * nothing live is still using it. A stable id
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

/**
 * One `JSON.stringify` per frame, not per socket.
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
  private readonly sockets = new Set<Socket>();
  /** One `JSON.stringify` per frame rather than per socket. See the class. */
  private readonly json = new FrameSerialiser();

  /**
   * @param server The host surface to feed — shared with the IPC transport,
   *   and disposed by whoever built it, not by this.
   * @param options.appVersion The desktop's version, sent in every hello
   *   reply so a relay-served page can load the matching build (ADR-206 D4).
   */
  constructor(
    private readonly server: BridgeServer,
    private readonly options: { appVersion?: string } = {},
  ) {}

  /** Live bridge sockets. The UI's "a browser is attached" signal. */
  get size(): number {
    return this.sockets.size;
  }

  /** Close every socket. Called when remote control is turned off. */
  closeAll(): void {
    for (const entry of [...this.sockets]) {
      this.drop(entry);
      try {
        entry.socket.close(1001, "server stopping");
        entry.socket.terminate?.();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.sockets.clear();
  }

  /**
   * Close every connection a device holds, with 4401 — the code a browser
   * reads as "re-pair". Called when a device is revoked: auth is
   * checked once, at hello, so without this a revoked device keeps its
   * session until it drops.
   *
   * The connection is dead from this call on, not from when the peer
   * acknowledges the close: the entry is dropped (so `onMessage` ignores
   * anything that still arrives on it) and the socket is then terminated.
   * A client that ignored the close frame would otherwise keep running
   * invokes until its carrier gave up waiting for it.
   */
  closeDevice(deviceId: string): void {
    for (const entry of [...this.sockets]) {
      if (entry.connection?.deviceId !== deviceId) continue;
      this.close(entry, CLOSE_UNAUTHORIZED, "device revoked");
      try {
        entry.socket.terminate?.();
      } catch {
        // Already gone.
      }
    }
  }

  /** The process is exiting; there is no restart. */
  dispose(): void {
    this.closeAll();
  }

  /**
   * Run the hello gate over a `FrameSocket`. The socket is accepted before it
   * has proved anything — see the header — and `authenticate` is run against
   * the first frame it sends.
   */
  attach(socket: FrameSocket, authenticate: BridgeAuthenticator): void {
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
    }, socket.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    entry.helloTimer.unref?.();

    socket.onMessage((text) => {
      void this.onMessage(entry, text, authenticate);
    });
    socket.onClose(() => this.drop(entry));
  }

  private async onMessage(
    entry: Socket,
    text: string,
    authenticate: BridgeAuthenticator,
  ): Promise<void> {
    // Closed by this side (revoked, refused, server stopping): whatever the
    // peer still sends before its socket is gone is not a caller's.
    if (!this.sockets.has(entry)) return;
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

    const answer = await this.server.receive(connection, frame);
    if (answer) this.send(entry, answer);
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
    // A reconnecting client's previous id is reused only when nothing live
    // already answers to it: two sockets racing to be the same renderer is
    // worse than either of them keeping the id it was just given.
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
    const reply: HelloReplyFrame = {
      type: "hello",
      ok: true,
      v: BRIDGE_PROTOCOL_VERSION,
      rendererId: entry.id,
      ...(this.options.appVersion !== undefined && {
        appVersion: this.options.appVersion,
      }),
    };
    this.send(entry, reply);
  }

  private idIsHeld(id: string, exclude: Socket): boolean {
    for (const entry of this.sockets) {
      if (entry !== exclude && entry.id === id) return true;
    }
    return false;
  }

  private send(entry: Socket, frame: unknown): void {
    if (!entry.socket.open) return;
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
