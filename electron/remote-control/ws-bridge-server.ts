/**
 * The WebSocket bridge (ADR-178 D8).
 *
 * One multiplexed socket per web renderer, carrying request/response frames
 * for what `invoke` did and event frames for what `on` did, plus the PTY
 * stream. The renderer talks to the Manor server only — never to the daemon,
 * whose token-file auth was designed for a loopback caller — so everything
 * arrives here and is proxied.
 *
 * **Authentication is a frame, not a URL.** The upgrade request carries no
 * token: a token in a query string is a token in a proxy log, in
 * `window.history`, and in whatever the tunnel writes down. The socket is
 * accepted, and then has five seconds to present `{"type":"hello","token":…}`
 * before it is closed. Until that frame lands the connection can do exactly
 * nothing, and `server.ts` runs the same `DeviceVerifier` and the same
 * failed-auth backoff the HTTP path runs — one gate, two transports.
 *
 * **Only a `full` device.** The `read` and `send` tiers are defined by an
 * allowlist of routes (ADR-161), and this surface is not an allowlist: it is
 * a handler table containing the terminal. A device below `full` is closed
 * with 4403 rather than given a smaller bridge, because a smaller bridge is a
 * second surface to keep honest.
 *
 * Close codes are in the application range on purpose — 4401 and 4403 read as
 * the HTTP statuses they mirror, and the client can tell "your token is wrong,
 * re-pair" from "your token is right and this tier cannot do this".
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import type { StreamEvent } from "../terminal-host/types";
import type { IpcDeps } from "../ipc/types";
import { RemoteAuditLog } from "./audit";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../renderer-broadcast";
import type { AuthenticatedDevice } from "./server";
import {
  BridgeRefusal,
  MUTATING,
  UNAVAILABLE_CODE,
  WS_HANDLERS,
  type BridgeHandler,
} from "./ws-handlers";

/** Bumped when a frame's shape changes in a way a client must notice. */
export const BRIDGE_PROTOCOL_VERSION = 1;

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

/** What `server.ts` answers when the bridge asks it to check a hello. */
export type BridgeAuthResult =
  | { ok: true; device: AuthenticatedDevice }
  | { ok: false; code: number };

/** The `verify + backoff + tier` decision, which lives in `server.ts`. */
export type BridgeAuthenticator = (token: unknown) => BridgeAuthResult;

/** How the PTY stream's six event types are named on the wire. */
const PTY_EVENT_NAMES: Record<StreamEvent["type"], string> = {
  data: "output",
  exit: "exit",
  cwd: "cwd",
  error: "error",
  agentStatus: "agentStatus",
  resized: "resized",
};

interface Connection {
  socket: WebSocket;
  device: AuthenticatedDevice | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /**
   * `ns.event` → the keys subscribed to. A `pty.*` subscription names a
   * `paneId`; everything else subscribes without one and gets `ALL_KEYS`.
   * Membership is the whole filter: a socket that never subscribed to pane B
   * never sees a byte of B's output, however much of it the daemon produces.
   */
  subscriptions: Map<string, Set<string>>;
}

/** The stand-in key for a subscription that named none. */
const ALL_KEYS = "*";

export interface WsBridgeServerOptions {
  audit?: RemoteAuditLog;
  /** Overridable so a test can assert dispatch without a real `IpcDeps`. */
  handlers?: Record<string, BridgeHandler>;
}

export class WsBridgeServer {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly connections = new Set<Connection>();
  private readonly audit: RemoteAuditLog;
  private readonly handlers: Record<string, BridgeHandler>;
  private readonly unsubscribeBroadcasts: () => void;

  constructor(
    private readonly deps: IpcDeps,
    options: WsBridgeServerOptions = {},
  ) {
    this.audit = options.audit ?? new RemoteAuditLog();
    this.handlers = options.handlers ?? WS_HANDLERS;
    this.unsubscribeBroadcasts = addRendererBroadcastSink((broadcast) =>
      this.onRendererBroadcast(broadcast),
    );
  }

  /** Live bridge sockets. The UI's "a browser is attached" signal. */
  get size(): number {
    return this.connections.size;
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
      this.accept(ws, authenticate);
    });
  }

  /**
   * One PTY stream event, forwarded to the sockets that asked for that pane.
   *
   * Called from the single `backend.pty.onEvent` subscription in
   * `app-lifecycle.ts` rather than taking one of its own: the daemon client
   * holds exactly one handler, and a second `onEvent` call would replace the
   * one that feeds the desktop windows.
   */
  handleStreamEvent(event: StreamEvent): void {
    const name = PTY_EVENT_NAMES[event.type];
    if (!name) return;
    // The argument shapes are the preload's, verbatim: `onOutput(paneId, (data,
    // seq))`, `onResized(paneId, (cols, rows))`, and so on. The bridge is a
    // second implementation of `window.electronAPI`, not a second protocol.
    const args: unknown[] =
      event.type === "data"
        ? [event.data, event.seq]
        : event.type === "resized"
          ? [event.cols, event.rows]
          : event.type === "cwd"
            ? [event.cwd]
            : event.type === "error"
              ? [event.message]
              : event.type === "agentStatus"
                ? [event.agent]
                : [];
    this.publish("pty", name, args, event.sessionId);
  }

  /** Close every socket. Called from `RemoteControlServer.stop()`. */
  closeAll(): void {
    for (const connection of [...this.connections]) {
      this.drop(connection);
      try {
        connection.socket.close(1001, "server stopping");
        connection.socket.terminate();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.connections.clear();
  }

  /** Release the broadcast sink. The process is exiting; there is no restart. */
  dispose(): void {
    this.closeAll();
    this.unsubscribeBroadcasts();
    this.wss.close();
  }

  private accept(socket: WebSocket, authenticate: BridgeAuthenticator): void {
    const connection: Connection = {
      socket,
      device: null,
      helloTimer: null,
      subscriptions: new Map(),
    };
    this.connections.add(connection);

    connection.helloTimer = setTimeout(() => {
      // Silent for five seconds with no token is indistinguishable from a
      // scanner that opened the socket to see what answers.
      this.close(connection, CLOSE_UNAUTHORIZED, "no hello");
    }, HELLO_TIMEOUT_MS);
    connection.helloTimer.unref?.();

    socket.on("message", (raw) => {
      void this.onMessage(connection, raw.toString(), authenticate);
    });
    socket.on("close", () => this.drop(connection));
    socket.on("error", () => this.drop(connection));
  }

  private async onMessage(
    connection: Connection,
    text: string,
    authenticate: BridgeAuthenticator,
  ): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("bad");
      frame = parsed as Record<string, unknown>;
    } catch {
      this.close(connection, CLOSE_UNAUTHORIZED, "malformed frame");
      return;
    }

    if (connection.device === null) {
      this.onHello(connection, frame, authenticate);
      return;
    }

    switch (frame.kind) {
      case "invoke":
        await this.onInvoke(connection, frame);
        return;
      case "subscribe":
        this.onSubscribe(connection, frame, true);
        return;
      case "unsubscribe":
        this.onSubscribe(connection, frame, false);
        return;
      default:
        // Unknown kinds are ignored rather than fatal: a newer client sending
        // a frame this version does not have should degrade, not disconnect.
        return;
    }
  }

  private onHello(
    connection: Connection,
    frame: Record<string, unknown>,
    authenticate: BridgeAuthenticator,
  ): void {
    if (frame.type !== "hello") {
      this.close(connection, CLOSE_UNAUTHORIZED, "hello must come first");
      return;
    }
    const result = authenticate(frame.token);
    if (!result.ok) {
      this.close(connection, result.code, "hello rejected");
      return;
    }
    if (connection.helloTimer) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    connection.device = result.device;
    this.send(connection, {
      type: "hello",
      ok: true,
      v: BRIDGE_PROTOCOL_VERSION,
    });
  }

  private async onInvoke(
    connection: Connection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const id = frame.id;
    const ns = frame.ns;
    const method = frame.method;
    if (typeof ns !== "string" || typeof method !== "string") {
      this.send(connection, {
        id,
        kind: "result",
        ok: false,
        error: "invoke needs a string ns and method",
        code: "bad-frame",
      });
      return;
    }
    const args = Array.isArray(frame.args) ? (frame.args as unknown[]) : [];
    const key = `${ns}.${method}`;
    const handler = this.handlers[key];
    if (!handler) {
      this.send(connection, {
        id,
        kind: "result",
        ok: false,
        error: `${key} is not available in the browser`,
        code: UNAVAILABLE_CODE,
      });
      return;
    }

    const audited = MUTATING.has(key);
    // Widened here and nowhere else — see `BridgeHandler`. Every handler
    // validates what it is given before it does anything with it.
    const call = handler as (deps: IpcDeps, ...args: unknown[]) => unknown;
    try {
      const result = await call(this.deps, ...args);
      if (audited) this.auditInvoke(connection, key, args, "sent", 200);
      this.send(connection, { id, kind: "result", ok: true, result });
    } catch (err) {
      if (audited) this.auditInvoke(connection, key, args, "failed", 500);
      const refusal = err instanceof BridgeRefusal;
      this.send(connection, {
        id,
        kind: "result",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: refusal ? UNAVAILABLE_CODE : "failed",
      });
    }
  }

  private onSubscribe(
    connection: Connection,
    frame: Record<string, unknown>,
    add: boolean,
  ): void {
    const ns = frame.ns;
    const event = frame.event;
    if (typeof ns !== "string" || typeof event !== "string") return;
    const name = `${ns}.${event}`;
    const key = typeof frame.key === "string" ? frame.key : ALL_KEYS;
    const keys = connection.subscriptions.get(name);
    if (add) {
      if (keys) keys.add(key);
      else connection.subscriptions.set(name, new Set([key]));
      return;
    }
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) connection.subscriptions.delete(name);
  }

  /**
   * A change the desktop windows were told about, forwarded to the browsers.
   * Keyless: `projects.changed` is about the machine, not about one pane.
   *
   * The names are `renderer-broadcast.ts`'s, and they line up with the
   * preload's subscriptions one-for-one, arguments included:
   *
   * | frame                   | preload                          |
   * | ----------------------- | -------------------------------- |
   * | `projects.changed`      | `onProjectsChanged(cb)`          |
   * | `agents.updated`        | `agents.onUpdate(cb)`            |
   * | `preferences.changed`   | `preferences.onChange(cb)`       |
   * | `keybindings.changed`   | `keybindings.onChange(cb)`       |
   * | `notifications.changed` | `notifications.onChanged(cb)`    |
   * | `stats.changed`         | `stats.onChanged(cb)`            |
   * | `remoteControl.status`  | `remoteControl.onStatus(cb)`     |
   * | `layout.changed`        | `layout.onChanged(cb)`           |
   *
   * `layout.changed` is the one that carries a *whole* workspace layout
   * (ADR-179 D1): the server is the only writer, so a renderer replaces its
   * replica rather than patching it.
   *
   * `theme` is absent from that list because the desktop has no theme
   * broadcast: a theme change comes back as the return value of
   * `theme:setSelected` to the one window that asked. A second viewer would
   * need one, and it is slice-2 work in the namespace that owns it — not a
   * forwarding rule invented here for a channel that does not exist.
   */
  private onRendererBroadcast(broadcast: RendererBroadcast): void {
    this.publish(broadcast.ns, broadcast.event, broadcast.args, null);
  }

  private publish(
    ns: string,
    event: string,
    args: unknown[],
    key: string | null,
  ): void {
    if (this.connections.size === 0) return;
    const name = `${ns}.${event}`;
    // The key rides along on the frame as well as filtering it. One socket
    // carries every pane the browser has open, and `args` for `pty.output` is
    // the preload's `(data, seq)` — nothing in it says which pane, so without
    // this the client could only deliver a pane's bytes to all of them.
    const payload = JSON.stringify(
      key === null
        ? { kind: "event", ns, event, args }
        : { kind: "event", ns, event, args, key },
    );
    for (const connection of this.connections) {
      if (connection.device === null) continue;
      const keys = connection.subscriptions.get(name);
      if (!keys) continue;
      if (key !== null && !keys.has(key) && !keys.has(ALL_KEYS)) continue;
      this.write(connection, payload);
    }
  }

  private auditInvoke(
    connection: Connection,
    route: string,
    args: unknown[],
    outcome: "sent" | "failed",
    status: number,
  ): void {
    const device = connection.device;
    if (!device) return;
    this.audit.append({
      at: new Date().toISOString(),
      deviceId: device.id,
      deviceLabel: device.label,
      tier: "full",
      transport: "bridge",
      route,
      target: bridgeTarget(args),
      // No bodies, for the reason `fullTierWrite` gives: the table's arguments
      // are too varied to fish in safely, and one of them is a keystroke.
      textLength: null,
      textSha256: null,
      interrupt: false,
      outcome,
      status,
    });
  }

  private send(connection: Connection, frame: unknown): void {
    this.write(connection, JSON.stringify(frame));
  }

  private write(connection: Connection, payload: string): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    try {
      connection.socket.send(payload);
    } catch {
      // A socket that died between the readyState check and the send is a
      // socket the 'close' handler is about to clean up.
    }
  }

  private close(connection: Connection, code: number, reason: string): void {
    this.drop(connection);
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private drop(connection: Connection): void {
    if (connection.helloTimer) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    this.connections.delete(connection);
  }
}

/**
 * What an audited invoke was aimed at.
 *
 * The first primitive argument, which for every method in `MUTATING` is the
 * paneId, the project index or the project id — the same "what did it point
 * at" the HTTP audit line records from a path capture. Objects are skipped
 * rather than serialized: that is where the bodies are.
 */
function bridgeTarget(args: unknown[]): string | null {
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" && Number.isFinite(arg)) return String(arg);
  }
  return null;
}
