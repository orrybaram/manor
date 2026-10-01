/**
 * A relay room with a desktop behind it, as one fake `WebSocket` the test
 * drives by hand (ADR-206). It runs the real Noise responder from
 * `relay-crypto`, so what it accepts is what the desktop connector accepts.
 */

import { x25519 } from "@noble/curves/ed25519.js";

import {
  SecureChannel,
  createResponder,
  packBatch,
  unpackBatch,
  type NoiseResponder,
} from "../../lib/relay-crypto";
import {
  CLOSE_NORMAL,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  PASSTHROUGH_CLOSE_CODES,
} from "../../lib/relay-crypto/protocol";

export type Frame = Record<string, unknown>;

export interface DesktopKey {
  pub: Uint8Array;
  priv: Uint8Array;
}

export function desktopKey(): DesktopKey {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export class FakeRelaySocket {
  static instances: FakeRelaySocket[] = [];
  /** The key the "desktop" behind every new socket answers with. */
  static key: DesktopKey;

  static get last(): FakeRelaySocket {
    const socket =
      FakeRelaySocket.instances[FakeRelaySocket.instances.length - 1];
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  readyState = 0;
  binaryType = "blob";
  /** Raw binary messages the browser sent, in order. */
  readonly sent: Uint8Array[] = [];
  /** Bridge frames the browser sent, decrypted by the desktop's channel. */
  readonly frames: Frame[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  private responder: NoiseResponder | null = null;
  private desktop: SecureChannel | null = null;

  constructor(readonly url: string) {
    FakeRelaySocket.instances.push(this);
  }

  /** Heartbeats the page sent (the room answers them; see `pong`). */
  pings = 0;

  send(data: unknown): void {
    if (data === HEARTBEAT_PING) {
      this.pings++;
      return;
    }
    if (!(data instanceof Uint8Array)) {
      throw new Error("the relay pipe must send binary");
    }
    this.sent.push(data.slice());
    if (this.desktop === null) return;
    for (const chunk of unpackBatch(data)) {
      const text = this.desktop.openFrame(chunk);
      if (text !== null) this.frames.push(JSON.parse(text) as Frame);
    }
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  /** The relay accepted the upgrade. The browser sends message 1. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The desktop reads message 1 and answers message 2. */
  respond(key: DesktopKey = FakeRelaySocket.key): void {
    const message1 = this.sent[0];
    if (!message1) throw new Error("no message 1 was sent");
    this.responder = createResponder(key);
    this.responder.readMessage1(message1);
    const result = this.responder.writeMessage2();
    this.desktop = new SecureChannel(result, "host");
    this.deliverRaw(result.message);
  }

  /** One bridge frame from the desktop, sealed and batched. */
  deliver(frame: unknown): void {
    if (!this.desktop) throw new Error("handshake not done");
    this.deliverRaw(packBatch(this.desktop.sealFrame(JSON.stringify(frame))));
  }

  /** Several bridge frames coalesced into one relay message. */
  deliverBatch(frames: unknown[]): void {
    const desktop = this.desktop;
    if (!desktop) throw new Error("handshake not done");
    this.deliverRaw(
      packBatch(frames.flatMap((f) => desktop.sealFrame(JSON.stringify(f)))),
    );
  }

  /** Bytes as the relay forwards them, unexamined. */
  deliverRaw(bytes: Uint8Array): void {
    this.onmessage?.({ data: toArrayBuffer(bytes) });
  }

  /** The room's answer to a heartbeat. */
  pong(): void {
    this.onmessage?.({ data: HEARTBEAT_PONG });
  }

  /** A text message other than a pong, which the relay never sends. */
  deliverText(text: string): void {
    this.onmessage?.({ data: text });
  }

  /**
   * The desktop closed this channel with `OP_CLOSE`, optionally carrying a
   * bridge close code; like `relay/src/room.ts`, only allow-listed codes
   * reach the browser and anything else is a normal close.
   */
  hostClose(code?: number): void {
    const passed =
      code !== undefined && PASSTHROUGH_CLOSE_CODES.has(code)
        ? code
        : CLOSE_NORMAL;
    this.drop(passed);
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Accept, handshake, and answer the hello. */
  handshake(reply: Frame = {}): void {
    this.accept();
    this.respond();
    this.deliver({
      type: "hello",
      ok: true,
      v: 1,
      rendererId: "r-1",
      ...reply,
    });
  }

  of(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }
}
