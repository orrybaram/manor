/**
 * The desktop's end of the relay (ADR-206 D5).
 *
 * Dials `wss://<relay>/host/<roomId>`, proves it owns the room by signing
 * the relay's challenge with the identity's Ed25519 key, and then turns each
 * `OP_OPEN` into a `RelayChannel` — a Noise responder that, once its
 * handshake is done, is handed to the bridge's hello gate like any socket.
 *
 * Host-side wire format (`relay-crypto/protocol.ts`):
 *
 * - relay → host, text: `{"t":"challenge","c":<b64u>}`, later `{"t":"ok"}`.
 * - host → relay, text: `{"t":"auth","pub":<b64u>,"sig":<b64u>}`.
 * - after `ok`, binary only, both ways: `[op, ch_hi, ch_lo, ...payload]`.
 *
 * **Nothing starts this.** It is constructed with the app and started by an
 * explicit user action (the controller, ADR-206 D6). While running it
 * reconnects on its own with a capped backoff (1 s → 30 s); being replaced
 * by another host holding the same key (4409) is final — two desktops
 * fighting over a room would otherwise take turns forever.
 *
 * **Flow control.** Every viewer shares this one socket, and the desktop's
 * uplink may be far slower than its PTYs. So nothing is written to the
 * socket blindly: each channel's relay messages wait in its own queue, and
 * the queues are drained round-robin, one message per turn, only while fewer
 * than `WINDOW_BYTES` are in flight — written but not yet acknowledged by
 * the room (`OP_ACK`). The window, not the socket's `bufferedAmount`, is
 * what bounds it: the kernel's TCP send buffer (megabytes, autotuned) is
 * invisible to `bufferedAmount`, and a backlog there is one nothing can
 * reorder. So a viewer streaming a busy pane cannot starve another viewer's
 * keystroke echo or a new viewer's handshake, and the backlog lives in
 * per-channel queues where it can be bounded (a channel too far behind is
 * closed, `relay/channel.ts`). Control traffic skips the queues and the
 * window: Noise message 2 (the viewer's handshake timer is running),
 * `OP_CLOSE`, and heartbeats.
 *
 * **Liveness.** A heartbeat (`HEARTBEAT_PING`, answered by the room) every
 * `pingIntervalMs`; any inbound message — a pong, an ack, a viewer's data —
 * counts as a sign of life. Behind a backlog the acks keep coming, so a
 * heartbeat queued behind it is not mistaken for a dead socket; nothing at
 * all for a whole interval is.
 *
 * **Status.** `starting` covers both the first dial and every reconnect after
 * a drop; while reconnecting, `error` says why the last connection ended.
 * `failed` is reserved for what reconnecting cannot fix (identity, URL,
 * replaced by another host, auth refused).
 */
import { WebSocket, type RawData } from "ws";

import {
  base64urlDecode,
  base64urlEncode,
  roomIdFor,
  signHostChallenge,
  type RelayIdentity,
} from "../../../src/lib/relay-crypto";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_REPLACED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_CHANNELS,
  MAX_RELAY_PAYLOAD_BYTES,
  OP_ACK,
  OP_CLOSE,
  OP_DATA,
  OP_OPEN,
  RELAY_ACK_BYTES,
  RELAY_HEADER_BYTES,
} from "../../../src/lib/relay-crypto/protocol";
import type { FrameSocket } from "../../bridge/transports/frame-socket";
import type { BridgeAuthenticator } from "../../bridge/transports/ws";
import type { TunnelState } from "../tunnel";
import { RelayChannel } from "./channel";
import { wipe } from "./identity";

/**
 * The production relay: the `manor-relay` Worker's custom domain
 * (`relay/wrangler.toml`). `MANOR_RELAY_URL` overrides it (e.g.
 * `ws://localhost:8787` for `pnpm relay:dev`).
 */
export const DEFAULT_RELAY_URL = "https://relay.manor.sh";

/** Same shape as `TunnelStatus`: `url` (the relay origin) is set in `running`. */
export interface RelayStatus {
  state: TunnelState;
  url: string | null;
  /**
   * Set in `failed`, and in `starting` while reconnecting after a drop (why
   * the last connection ended). See "Status" in the header.
   */
  error: string | null;
}

/**
 * Queued data is written only while fewer than this many bytes are in
 * flight to the room. Everything urgent — another viewer's message 2, a
 * close, a heartbeat — waits behind at most this much, so it is small; it
 * also caps throughput at one window per round trip (512 KiB per 100 ms is
 * 5 MiB/s), which is more than a home uplink.
 */
const WINDOW_BYTES = 512 * 1024;

/**
 * Viewer channels this connector holds at once. The room allows
 * `MAX_CHANNELS`; the slack covers channels the room has reassigned before
 * this side has seen the old one close. Anything past it is refused with
 * `OP_CLOSE`, so a misbehaving relay cannot make main hold a Noise responder
 * per `OP_OPEN`.
 */
const MAX_OPEN_CHANNELS = MAX_CHANNELS * 2;

/** Largest message the relay may send this socket: one header plus payload. */
const MAX_INBOUND_BYTES = RELAY_HEADER_BYTES + MAX_RELAY_PAYLOAD_BYTES;

export interface RelayEndpoint {
  /** `https://host[:port]` — where the web app is served and links point. */
  origin: string;
  /** `wss://host[:port]` — where the host socket dials. */
  socketBase: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parse a relay URL (`https://`, `wss://`, or — for a localhost dev relay
 * only — `http://` / `ws://`) into its origin and socket base. Throws on
 * anything else: an unencrypted remote relay would leak room ids and
 * metadata, even though channel content is end-to-end encrypted.
 */
export function parseRelayUrl(raw: string): RelayEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid relay URL: ${raw}`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const insecure = url.protocol === "http:" || url.protocol === "ws:";
  if (!secure && !insecure) {
    throw new Error(`Relay URL must be https:// or wss://, got ${raw}`);
  }
  if (insecure && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Relay URL must be https:// or wss:// unless it is localhost, got ${raw}`,
    );
  }
  return {
    origin: `${secure ? "https" : "http"}://${url.host}`,
    socketBase: `${secure ? "wss" : "ws"}://${url.host}`,
  };
}

/** `MANOR_RELAY_URL` if set, else `DEFAULT_RELAY_URL`. */
export function resolveRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MANOR_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}

/** What the connector needs of `RelayIdentityStore`. */
export interface RelayIdentitySource {
  /** The full identity; the connector wipes its copy when it stops. */
  load(): RelayIdentity;
}

export interface RelayConnectorDeps {
  identity: RelayIdentitySource;
  /** `WsBridgeServer` — each finished channel is `attach`ed to it. */
  bridge: { attach(socket: FrameSocket, auth: BridgeAuthenticator): void };
  /** `RemoteControlServer.authenticateRelayHello`. */
  authenticate: BridgeAuthenticator;
  /** Defaults to `resolveRelayUrl()`. */
  relayUrl?: string;
  /** Test seams; production uses the defaults. */
  timing?: Partial<RelayTiming>;
}

export interface RelayTiming {
  backoffMinMs: number;
  backoffMaxMs: number;
  /** A socket that has not reached `ok` by now is dropped and redialled. */
  authTimeoutMs: number;
  /**
   * Heartbeat interval. No inbound message since the last heartbeat and no
   * write progress since the last tick drops the socket.
   */
  pingIntervalMs: number;
  channelHandshakeTimeoutMs?: number;
  flushIntervalMs?: number;
  flushBytes?: number;
}

const DEFAULT_TIMING: RelayTiming = {
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  authTimeoutMs: 15_000,
  pingIntervalMs: HEARTBEAT_INTERVAL_MS,
};

/** One channel's relay messages, framed, waiting for the socket. */
interface Outbound {
  messages: Uint8Array[];
  bytes: number;
}

export class RelayConnector {
  private state: RelayStatus = { state: "stopped", url: null, error: null };
  private readonly listeners = new Set<(status: RelayStatus) => void>();
  private readonly channels = new Map<number, RelayChannel>();
  private readonly timing: RelayTiming;
  private readonly relayUrl: string;

  private socket: WebSocket | null = null;
  private identity: RelayIdentity | null = null;
  private roomId: string | null = null;
  private endpoint: RelayEndpoint | null = null;
  private authed = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** True from a heartbeat until the next inbound message of any kind. */
  private awaitingPong = false;
  /** Binary bytes written to the socket and not yet acknowledged. */
  private inFlight = 0;
  /**
   * Per-channel queues, in round-robin order: a channel that has just had
   * its turn is moved to the back (Map iteration is insertion order).
   */
  private readonly outbound = new Map<number, Outbound>();

  constructor(private readonly deps: RelayConnectorDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.relayUrl = deps.relayUrl ?? resolveRelayUrl();
    this.backoffMs = this.timing.backoffMinMs;
  }

  get status(): RelayStatus {
    return { ...this.state };
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The relay's web origin (`https://…`), for building pairing links even
   * while stopped. Null if the configured URL is invalid.
   */
  get origin(): string | null {
    try {
      return parseRelayUrl(this.relayUrl).origin;
    } catch {
      return null;
    }
  }

  /** Viewer channels currently open (handshaking or live). */
  get channelCount(): number {
    return this.channels.size;
  }

  /**
   * Dial the relay. Idempotent while starting or running. Errors (no
   * keychain, bad URL) land in `failed` rather than throwing.
   */
  start(): void {
    if (this.state.state === "starting" || this.state.state === "running") {
      return;
    }
    let endpoint: RelayEndpoint;
    let identity: RelayIdentity;
    try {
      endpoint = parseRelayUrl(this.relayUrl);
      identity = this.deps.identity.load();
    } catch (err) {
      this.setState({ state: "failed", url: null, error: messageOf(err) });
      return;
    }
    this.endpoint = endpoint;
    this.identity = identity;
    this.roomId = roomIdFor(identity.ed25519.pub);
    this.backoffMs = this.timing.backoffMinMs;
    this.setState({ state: "starting", url: null, error: null });
    this.dial();
  }

  /** Close the socket, every channel, and forget the private keys. */
  stop(): void {
    this.teardown();
    this.setState({ state: "stopped", url: null, error: null });
  }

  // --- The host socket ----------------------------------------------------

  private dial(): void {
    const endpoint = this.endpoint;
    const roomId = this.roomId;
    if (!endpoint || !roomId) return;
    this.authed = false;
    const socket = new WebSocket(`${endpoint.socketBase}/host/${roomId}`, {
      handshakeTimeout: this.timing.authTimeoutMs,
      // Ciphertext does not compress, and inflating what a relay sends is a
      // way for it to make main allocate.
      perMessageDeflate: false,
      maxPayload: MAX_INBOUND_BYTES,
    });
    socket.binaryType = "nodebuffer";
    this.socket = socket;

    this.authTimer = setTimeout(() => {
      if (this.socket === socket && !this.authed) socket.terminate();
    }, this.timing.authTimeoutMs);
    this.authTimer.unref?.();

    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket) return;
      this.awaitingPong = false;
      if (isBinary) this.onBinary(socket, toBytes(data));
      else this.onText(socket, toBytes(data));
    });
    socket.on("error", (err) => {
      // A `close` always follows; it decides what happens next.
      if (this.socket === socket) {
        console.warn(`[remote-control] relay socket error: ${err.message}`);
      }
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.onSocketClosed(code, reason.toString());
    });
  }

  private onText(socket: WebSocket, bytes: Uint8Array): void {
    const text = Buffer.from(bytes).toString("utf8");
    // The heartbeat's answer; it has already counted as a sign of life.
    if (text === HEARTBEAT_PONG) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      socket.close(1002, "bad text message");
      return;
    }
    const identity = this.identity;
    const roomId = this.roomId;
    if (message.t === "challenge" && typeof message.c === "string") {
      if (this.authed || !identity || !roomId) return;
      try {
        const sig = signHostChallenge(
          identity.ed25519.priv,
          roomId,
          base64urlDecode(message.c),
        );
        socket.send(
          JSON.stringify({
            t: "auth",
            pub: base64urlEncode(identity.ed25519.pub),
            sig: base64urlEncode(sig),
          }),
        );
      } catch {
        socket.close(1002, "bad challenge");
      }
    } else if (message.t === "ok") {
      if (this.authed) return;
      this.authed = true;
      this.clearAuthTimer();
      this.backoffMs = this.timing.backoffMinMs;
      this.startPing(socket);
      this.setState({
        state: "running",
        url: this.endpoint?.origin ?? null,
        error: null,
      });
    }
  }

  private onBinary(socket: WebSocket, bytes: Uint8Array): void {
    if (!this.authed) {
      socket.close(1002, "binary before auth");
      return;
    }
    if (bytes.length < RELAY_HEADER_BYTES) return;
    const op = bytes[0];
    const ch = (bytes[1] << 8) | bytes[2];
    const payload = bytes.subarray(RELAY_HEADER_BYTES);
    if (op === OP_ACK) {
      if (bytes.length !== RELAY_ACK_BYTES) return;
      const n = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getUint32(3, false);
      this.inFlight = Math.max(0, this.inFlight - n);
      this.pump();
    } else if (op === OP_OPEN) {
      this.openChannel(ch);
    } else if (op === OP_DATA) {
      const channel = this.channels.get(ch);
      if (channel) channel.receive(payload);
      else this.sendControl(OP_CLOSE, ch);
    } else if (op === OP_CLOSE) {
      this.channels.get(ch)?.remoteClosed();
    }
    // Unknown ops are ignored: a newer relay may say things this host
    // does not need to understand.
  }

  private openChannel(ch: number): void {
    const identity = this.identity;
    if (!identity) return;
    // The relay reuses a channel number only after the previous viewer left
    // (and only after 65 535 other joins).
    this.channels.get(ch)?.remoteClosed();
    if (this.channels.size >= MAX_OPEN_CHANNELS) {
      this.sendControl(OP_CLOSE, ch);
      return;
    }
    const channel = new RelayChannel(ch, {
      staticKey: identity.x25519,
      sendPayload: (payload, urgent) => {
        if (urgent) this.sendControl(OP_DATA, ch, payload);
        else this.enqueue(ch, frame(OP_DATA, ch, payload));
      },
      backlogBytes: () => this.outbound.get(ch)?.bytes ?? 0,
      sendClose: (code) =>
        this.sendControl(
          OP_CLOSE,
          ch,
          code === undefined
            ? undefined
            : Uint8Array.of((code >> 8) & 0xff, code & 0xff),
        ),
      onReady: (ready) =>
        this.deps.bridge.attach(ready, this.deps.authenticate),
      onGone: (gone) => {
        if (this.channels.get(ch) !== gone) return;
        this.channels.delete(ch);
        this.outbound.delete(ch);
      },
      handshakeTimeoutMs: this.timing.channelHandshakeTimeoutMs,
      flushIntervalMs: this.timing.flushIntervalMs,
      flushBytes: this.timing.flushBytes,
    });
    this.channels.set(ch, channel);
  }

  // --- Sending: control now, data through the per-channel queues ---------

  private writable(): WebSocket | null {
    const socket = this.socket;
    if (!socket || !this.authed || socket.readyState !== WebSocket.OPEN) {
      return null;
    }
    return socket;
  }

  /** Write straight to the socket, ahead of every queue and the window. */
  private sendControl(op: number, ch: number, payload?: Uint8Array): void {
    const socket = this.writable();
    if (socket) this.write(socket, frame(op, ch, payload));
  }

  /** A binary message; the room acknowledges each one (`OP_ACK`). */
  private write(socket: WebSocket, message: Uint8Array): void {
    this.inFlight += message.length;
    socket.send(message, { binary: true });
  }

  private enqueue(ch: number, message: Uint8Array): void {
    if (!this.writable()) return;
    let queue = this.outbound.get(ch);
    if (!queue) {
      queue = { messages: [], bytes: 0 };
      this.outbound.set(ch, queue);
    }
    queue.messages.push(message);
    queue.bytes += message.length;
    this.pump();
  }

  /**
   * Move queued messages onto the socket, one per channel per turn, while
   * the window has room. Re-run on every enqueue and every ack.
   */
  private pump(): void {
    const socket = this.writable();
    if (!socket) return;
    while (this.outbound.size > 0 && this.inFlight < WINDOW_BYTES) {
      const [ch, queue] = this.outbound.entries().next().value as [
        number,
        Outbound,
      ];
      this.outbound.delete(ch);
      const message = queue.messages.shift();
      if (!message) continue;
      queue.bytes -= message.length;
      if (queue.messages.length > 0) this.outbound.set(ch, queue);
      this.write(socket, message);
    }
  }

  private clearOutbound(): void {
    this.outbound.clear();
    this.inFlight = 0;
  }

  private onSocketClosed(code: number, reason: string): void {
    this.socket = null;
    this.authed = false;
    this.clearAuthTimer();
    this.stopPing();
    this.closeChannels();
    this.clearOutbound();

    if (code === CLOSE_REPLACED) {
      this.teardown();
      this.setState({
        state: "failed",
        url: null,
        error:
          "Another Manor with this relay identity connected to the relay, " +
          "so this one was disconnected. Stop the relay on the other machine, " +
          "or reset this machine's relay address.",
      });
      return;
    }
    if (code === CLOSE_AUTH_FAILED) {
      this.teardown();
      this.setState({
        state: "failed",
        url: null,
        error: "The relay rejected this machine's identity.",
      });
      return;
    }

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
    this.setState({
      state: "starting",
      url: null,
      error: `Relay connection lost (${code}${reason ? ` ${reason}` : ""}); reconnecting`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    const heartbeat = () => {
      this.awaitingPong = true;
      try {
        socket.send(HEARTBEAT_PING, { binary: false });
      } catch {
        // Closing; `close` handles it.
      }
    };
    // One straight away: the room reaps a host it has not heard from.
    heartbeat();
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket) return;
      if (this.awaitingPong) {
        // Nothing at all — no pong, no ack, no viewer data — for a whole
        // interval: the machine slept, or the network changed under it.
        socket.terminate();
        return;
      }
      heartbeat();
    }, this.timing.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private closeChannels(): void {
    for (const channel of [...this.channels.values()]) channel.remoteClosed();
    this.channels.clear();
  }

  /** Drop the socket, the channels, the timers and the private keys. */
  private teardown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAuthTimer();
    this.stopPing();
    this.closeChannels();
    this.clearOutbound();
    const socket = this.socket;
    this.socket = null;
    this.authed = false;
    if (socket) {
      try {
        socket.close(1000, "stopped");
      } catch {
        socket.terminate();
      }
    }
    if (this.identity) wipe(this.identity);
    this.identity = null;
    this.roomId = null;
    this.endpoint = null;
  }

  private setState(next: RelayStatus): void {
    this.state = next;
    const snapshot = { ...next };
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** `[op, ch_hi, ch_lo, ...payload]`. */
function frame(op: number, ch: number, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(RELAY_HEADER_BYTES + (payload?.length ?? 0));
  out[0] = op;
  out[1] = (ch >> 8) & 0xff;
  out[2] = ch & 0xff;
  if (payload) out.set(payload, RELAY_HEADER_BYTES);
  return out;
}

function toBytes(data: RawData): Uint8Array {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
