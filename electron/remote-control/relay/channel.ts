/**
 * One viewer on the relay (ADR-206 D2, D5): a Noise NK responder, and then —
 * once the handshake is done — a `FrameSocket` the bridge's hello gate runs
 * over exactly as it runs over a local WebSocket.
 *
 * On the wire (payloads only; the connector adds and strips the 3-byte relay
 * header):
 *
 * 1. viewer → host: Noise message 1, bare.
 * 2. host → viewer: Noise message 2, bare.
 * 3. both ways: batches of Noise transport messages (`packBatch`).
 *
 * **Failures are final.** A handshake that fails or does not finish in time,
 * a batch that does not parse, a transport message that does not decrypt:
 * the channel is closed (`OP_CLOSE`) and never retried — a retry is what a
 * replaying relay would want. The browser reconnects with a fresh session.
 *
 * **Coalescing.** PTY output is many small frames and the relay bills and
 * rate-limits per message, so sealed chunks queue and are flushed every
 * `flushIntervalMs` or once `flushBytes` are waiting, packed with
 * `packBatches` into relay messages of at most `RELAY_BATCH_BYTES` (a frame
 * of up to `MAX_HOST_FRAME_BYTES` spans as many as it needs).
 *
 * **Backlog.** Flushed batches go to the connector's per-channel queue, which
 * drains into the shared host socket only as fast as the uplink takes it
 * (`connector.ts`). A viewer whose queue is already over
 * `CHANNEL_BACKLOG_BYTES` when the bridge hands it another frame is closed
 * rather than buffered for without bound: it reconnects and gets a fresh
 * snapshot, which is what a viewer that far behind wants anyway.
 *
 * **Before the hello.** Until the first frame (the hello) has decrypted, a
 * channel accepts at most `PRE_HELLO_BYTES` from its viewer. Anyone holding
 * the room id and the desktop's public key can get this far; they do not get
 * to make Electron main decrypt and buffer megabytes for free.
 */
import {
  SecureChannel,
  createResponder,
  packBatches,
  unpackBatch,
  type NoiseResponder,
} from "../../../src/lib/relay-crypto";
import { PASSTHROUGH_CLOSE_CODES } from "../../../src/lib/relay-crypto/protocol";
import type { FrameSocket } from "../../bridge/transports/frame-socket";

/** The desktop has this long after `OP_OPEN` to finish the Noise handshake. */
const CHANNEL_HANDSHAKE_TIMEOUT_MS = 5_000;
/** Outgoing chunks wait at most this long to be batched. */
const FLUSH_INTERVAL_MS = 16;
/** ...or until this many sealed bytes are waiting. */
const FLUSH_BYTES = 64 * 1024;
/**
 * Largest relay message the desktop sends. Below the relay's 1 MiB cap on
 * purpose: the connector schedules channels a message at a time, so this is
 * also how long one viewer's turn can hold up the others.
 */
export const RELAY_BATCH_BYTES = 256 * 1024;
/** A viewer this far behind is closed rather than queued for. */
export const CHANNEL_BACKLOG_BYTES = 8 * 1024 * 1024;
/** What a viewer may send before its first frame (the hello) decrypts. */
export const PRE_HELLO_BYTES = 64 * 1024;
/**
 * The bridge's hello window for a relay channel. Longer than the listener's
 * 5 s: the clock starts when message 2 is queued, and on a slow uplink it
 * can sit behind other viewers' output before it leaves the machine.
 */
export const RELAY_HELLO_TIMEOUT_MS = 20_000;

export interface RelayChannelOptions {
  /** The relay identity's X25519 key pair (copied by the responder). */
  staticKey: { pub: Uint8Array; priv: Uint8Array };
  /**
   * Queue one payload for this channel's viewer (connector adds `OP_DATA`).
   * `urgent` skips the channel's queue — for Noise message 2, which nothing
   * else on the channel can precede and which the viewer's handshake timer
   * is waiting on.
   */
  sendPayload(payload: Uint8Array, urgent?: boolean): void;
  /** Bytes queued in the connector for this channel, not yet on the wire. */
  backlogBytes?(): number;
  /**
   * Tell the relay this channel is gone (connector sends `OP_CLOSE`), with
   * the bridge's close code when it is one the relay passes to the viewer.
   */
  sendClose(code?: number): void;
  /** The handshake finished; the channel is now a usable `FrameSocket`. */
  onReady(channel: RelayChannel): void;
  /** Called once when the channel is closed, by either side. */
  onGone?(channel: RelayChannel): void;
  handshakeTimeoutMs?: number;
  flushIntervalMs?: number;
  flushBytes?: number;
  /** Test seam for `CHANNEL_BACKLOG_BYTES`. */
  backlogLimitBytes?: number;
}

type State = "handshaking" | "open" | "closed";

export class RelayChannel implements FrameSocket {
  private state: State = "handshaking";
  private responder: NoiseResponder | null;
  private secure: SecureChannel | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Bytes received since the handshake, until the first frame decrypts. */
  private preHelloBytes = 0;
  private gotFrame = false;
  private messageListeners: Array<(text: string) => void> = [];
  private closeListeners: Array<() => void> = [];
  private readonly flushIntervalMs: number;
  private readonly flushBytes: number;
  private readonly backlogLimit: number;
  /** See `RELAY_HELLO_TIMEOUT_MS`; read by the bridge's hello gate. */
  readonly helloTimeoutMs = RELAY_HELLO_TIMEOUT_MS;

  constructor(
    readonly ch: number,
    private readonly options: RelayChannelOptions,
  ) {
    this.responder = createResponder(options.staticKey);
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.flushBytes = options.flushBytes ?? FLUSH_BYTES;
    this.backlogLimit = options.backlogLimitBytes ?? CHANNEL_BACKLOG_BYTES;
    this.handshakeTimer = setTimeout(
      () => this.fail("handshake timeout"),
      options.handshakeTimeoutMs ?? CHANNEL_HANDSHAKE_TIMEOUT_MS,
    );
    this.handshakeTimer.unref?.();
  }

  // --- From the relay -----------------------------------------------------

  /** One payload the relay forwarded from this channel's viewer. */
  receive(payload: Uint8Array): void {
    if (this.state === "closed") return;
    if (this.state === "handshaking") {
      this.handshake(payload);
      return;
    }
    const secure = this.secure as SecureChannel;
    if (!this.gotFrame) {
      this.preHelloBytes += payload.length;
      if (this.preHelloBytes > PRE_HELLO_BYTES) {
        this.fail("too much before hello");
        return;
      }
    }
    // Decrypt the whole batch before delivering any of it, so a listener
    // that throws is not mistaken for a channel failure.
    const frames: string[] = [];
    try {
      for (const chunk of unpackBatch(payload)) {
        const text = secure.openFrame(chunk);
        if (text !== null) frames.push(text);
      }
    } catch {
      this.fail("decrypt failed");
      return;
    }
    if (frames.length > 0) this.gotFrame = true;
    for (const text of frames) {
      for (const listener of this.messageListeners) {
        if (this.state !== "open") return;
        listener(text);
      }
    }
  }

  /** The relay closed this channel, or the host socket went away. */
  remoteClosed(): void {
    this.finish(false);
  }

  private handshake(message1: Uint8Array): void {
    const responder = this.responder;
    this.responder = null;
    if (!responder) {
      this.fail("handshake out of order");
      return;
    }
    let message2: Uint8Array;
    try {
      responder.readMessage1(message1);
      const result = responder.writeMessage2();
      message2 = result.message;
      this.secure = new SecureChannel(result, "host");
    } catch {
      this.fail("handshake failed");
      return;
    }
    this.clearHandshakeTimer();
    this.state = "open";
    // Message 2 is bare, never batched, and goes ahead of everything.
    this.options.sendPayload(message2, true);
    this.options.onReady(this);
  }

  // --- FrameSocket --------------------------------------------------------

  get open(): boolean {
    return this.state === "open";
  }

  send(text: string): void {
    const secure = this.secure;
    if (this.state !== "open" || secure === null) return;
    // Checked before this frame is added, so one frame of any size is always
    // admitted to a channel that is keeping up.
    const backlog = this.pendingBytes + (this.options.backlogBytes?.() ?? 0);
    if (backlog > this.backlogLimit) {
      this.fail("viewer too far behind");
      return;
    }
    let chunks: Uint8Array[];
    try {
      chunks = secure.sealFrame(text);
    } catch {
      // Too large, or the session is spent. Either way the viewer would
      // desynchronise on a silently dropped frame; close and let it reconnect.
      this.fail("seal failed");
      return;
    }
    for (const chunk of chunks) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
    if (this.pendingBytes >= this.flushBytes) {
      this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /**
   * The bridge is done with this viewer. Anything still queued for it is
   * dropped, and `OP_CLOSE` goes ahead of other channels' output: the bridge
   * never writes a reply it needs delivered before a close (a refused hello
   * or a revoked device gets the code, not a frame), and a revoked viewer
   * should not keep receiving a backlog.
   */
  close(code: number, _reason: string): void {
    this.finish(true, PASSTHROUGH_CLOSE_CODES.has(code) ? code : undefined);
  }

  onMessage(cb: (text: string) => void): void {
    this.messageListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  // --- Internals ----------------------------------------------------------

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0 || this.state !== "open") return;
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const batch of packBatches(chunks, RELAY_BATCH_BYTES)) {
      this.options.sendPayload(batch);
    }
  }

  private fail(reason: string): void {
    if (this.state === "closed") return;
    console.warn(`[remote-control] relay channel ${this.ch} closed: ${reason}`);
    this.finish(true);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private finish(notifyRelay: boolean, code?: number): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearHandshakeTimer();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.responder = null;
    this.secure = null;
    if (notifyRelay) this.options.sendClose(code);
    this.options.onGone?.(this);
    const listeners = this.closeListeners;
    this.closeListeners = [];
    this.messageListeners = [];
    for (const listener of listeners) listener();
  }
}
