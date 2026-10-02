/**
 * The relay's `Pipe` (ADR-206 D2, D3): a WebSocket to the relay origin's
 * `/join/<roomId>`, a Noise NK handshake against the desktop's X25519 key
 * from the pairing link, and then the bridge's text frames as Noise
 * transport messages.
 *
 * `./ws.ts` sees exactly what it sees from a plain WebSocket: `onOpen` once
 * the handshake is done (so its `hello` is the first transport message),
 * text in, text out, and a close code. Everything that is about the relay
 * stays here.
 *
 * On the wire, after the socket opens:
 *
 * 1. browser → relay: Noise message 1, bare.
 * 2. relay → browser: Noise message 2, bare.
 * 3. both ways: batches (`packBatch` in `relay-crypto/channel.ts`). The
 *    browser sends one frame's chunks per batch, splitting a frame across
 *    batches only when it would exceed the relay's per-message cap.
 *
 * **Close codes.** The desktop's bridge verdict 4401 (bad or revoked token)
 * rides through the relay on `OP_CLOSE` and is handed to the transport
 * unchanged: forget the pairing. Everything else that
 * means "the desktop is not there right now" is *reachability*, not
 * credentials, and is listed in `unreachableCodes` so the transport retries
 * it with its usual backoff and the page says "not reachable" instead of
 * looking frozen: the relay's 4404 (no host — the desktop is asleep, or relay
 * mode is off), 4429 (channel cap or daily budget) and 4410 (this socket
 * stopped heartbeating), and this page's own `CLOSE_RELAY_UNREACHABLE` — the
 * desktop never answered message 1, or the relay stopped answering the
 * heartbeat.
 *
 * **Heartbeat.** Every `HEARTBEAT_INTERVAL_MS` the page sends the text
 * `HEARTBEAT_PING`, which the room answers itself. It keeps this viewer from
 * being reaped as a ghost, and an interval with nothing at all coming back
 * (no pong, no data) is a dead line — reported as unreachable rather than
 * left to look connected.
 *
 * **Failures.** A message 2 that does not authenticate is *not* treated as
 * proof of a key mismatch. A genuine mismatch fails on the desktop, at
 * message 1, and a reset desktop is a different room (4404); what reaches
 * this page as a bad message 2 is far more likely misrouted or stale bytes.
 * So it is reconnected like any other channel failure, and only
 * `KEY_MISMATCH_THRESHOLD` of them in a row, with no good handshake between,
 * are reported as `CLOSE_KEY_MISMATCH` — for which the transport stops and
 * asks to re-pair (`onKeyMismatch`) instead of forgetting credentials. A
 * malformed handshake message, a batch or transport message that fails to
 * parse or authenticate, are `CLOSE_CHANNEL_FAILED` and reconnected: a fresh
 * Noise session, never a retry of the poisoned one.
 */

import {
  SecureChannel,
  createInitiator,
  packBatches,
  unpackBatch,
  type NoiseInitiator,
} from "../../lib/relay-crypto";
import {
  CLOSE_IDLE,
  CLOSE_LIMIT,
  CLOSE_NO_HOST,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_RELAY_PAYLOAD_BYTES,
} from "../../lib/relay-crypto/protocol";
import { CLOSE_KEY_MISMATCH, type Pipe, type PipeConnection } from "./ws";

/**
 * This page's own codes — never sent on the wire, only handed to the
 * transport. "The encrypted channel broke" is reconnected like a dropped
 * line; "the desktop or the relay is not answering" is that, and also shown.
 */
const CLOSE_CHANNEL_FAILED = 4500;
export const CLOSE_RELAY_UNREACHABLE = 4504;

/** How long the desktop has to answer message 1 before the dial is retried. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Bad message 2s in a row, with no good handshake between, before re-pair. */
export const KEY_MISMATCH_THRESHOLD = 3;

export interface RelayPipeOptions {
  /** `wss://<relay-origin>/join/<roomId>`. */
  url: string;
  /** The desktop's X25519 static public key, from the pairing link. */
  serverKey: Uint8Array;
}

/** `wss://` (or `ws://`) this page's own origin, at `/join/<roomId>`. */
export function relayJoinUrl(roomId: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/join/${encodeURIComponent(roomId)}`;
}

export function relayPipe(options: RelayPipeOptions): Pipe {
  /** Across dials: message 2s that failed since the last good handshake. */
  let badMessage2s = 0;
  return {
    unreachableCodes: new Set([
      CLOSE_NO_HOST,
      CLOSE_LIMIT,
      CLOSE_IDLE,
      CLOSE_RELAY_UNREACHABLE,
    ]),
    connect(handlers): PipeConnection {
      const socket = new WebSocket(options.url);
      socket.binaryType = "arraybuffer";
      let initiator: NoiseInitiator | null = null;
      let channel: SecureChannel | null = null;
      let closed = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      /** True from a heartbeat until anything at all arrives. */
      let awaitingPong = false;

      const clearTimers = (): void => {
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };

      /** Report the close once; the socket's own close, if later, is moot. */
      const finish = (code: number): void => {
        if (closed) return;
        closed = true;
        clearTimers();
        initiator = null;
        channel = null;
        handlers.onClose(code);
      };

      const fail = (code: number): void => {
        try {
          socket.close(1000, "channel failed");
        } catch {
          // Already closing.
        }
        finish(code);
      };

      const onHandshake = (message: Uint8Array): void => {
        const pending = initiator;
        initiator = null;
        if (pending === null) {
          fail(CLOSE_CHANNEL_FAILED);
          return;
        }
        try {
          channel = new SecureChannel(pending.readMessage2(message), "viewer");
        } catch {
          badMessage2s += 1;
          fail(
            badMessage2s >= KEY_MISMATCH_THRESHOLD
              ? CLOSE_KEY_MISMATCH
              : CLOSE_CHANNEL_FAILED,
          );
          return;
        }
        badMessage2s = 0;
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        handlers.onOpen();
      };

      const onTransport = (live: SecureChannel, message: Uint8Array): void => {
        // Decrypt the whole batch before delivering any of it, so a listener
        // that throws is not mistaken for a channel failure.
        const frames: string[] = [];
        try {
          for (const chunk of unpackBatch(message)) {
            const text = live.openFrame(chunk);
            if (text !== null) frames.push(text);
          }
        } catch {
          fail(CLOSE_CHANNEL_FAILED);
          return;
        }
        for (const text of frames) {
          if (closed) return;
          handlers.onMessage(text);
        }
      };

      socket.onopen = () => {
        if (closed) return;
        // Armed before message 1 goes out, so an answer — however fast —
        // always finds a timer to clear. No answer at all means a desktop
        // that is not there (asleep behind a socket the relay has not yet
        // given up on), which the page should say.
        handshakeTimer = setTimeout(
          () => fail(CLOSE_RELAY_UNREACHABLE),
          HANDSHAKE_TIMEOUT_MS,
        );
        heartbeatTimer = setInterval(() => {
          if (awaitingPong) {
            fail(CLOSE_RELAY_UNREACHABLE);
            return;
          }
          awaitingPong = true;
          try {
            socket.send(HEARTBEAT_PING);
          } catch {
            // Closing; `onclose` reports it.
          }
        }, HEARTBEAT_INTERVAL_MS);
        try {
          initiator = createInitiator(options.serverKey);
          socket.send(initiator.writeMessage1());
        } catch {
          fail(CLOSE_CHANNEL_FAILED);
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        if (closed) return;
        awaitingPong = false;
        if (event.data === HEARTBEAT_PONG) return;
        if (!(event.data instanceof ArrayBuffer)) {
          // The relay only ever forwards binary; other text is not ours.
          fail(CLOSE_CHANNEL_FAILED);
          return;
        }
        const message = new Uint8Array(event.data);
        if (channel === null) onHandshake(message);
        else onTransport(channel, message);
      };

      socket.onclose = (event: CloseEvent) => finish(event.code);
      socket.onerror = () => {
        // A `close` always follows, and it carries the code that matters.
      };

      return {
        get open() {
          return !closed && channel !== null && socket.readyState === 1;
        },
        send(text) {
          const live = channel;
          if (closed || live === null) {
            throw new Error("relay channel is not open");
          }
          let batches: Uint8Array[];
          try {
            batches = packBatches(
              live.sealFrame(text),
              MAX_RELAY_PAYLOAD_BYTES,
            );
          } catch (err) {
            // `sealFrame` poisons the channel on any failure; it cannot be
            // used again, so this connection is over.
            fail(CLOSE_CHANNEL_FAILED);
            throw err;
          }
          for (const batch of batches) socket.send(batch);
        },
      };
    },
  };
}
