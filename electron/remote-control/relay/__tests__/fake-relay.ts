/**
 * An in-process relay (ADR-206 D1) over a real `ws` server, implementing the
 * room protocol of `relay/src/room.ts` closely enough that what the
 * connector does against it is what it does against the Worker: text
 * challenge/auth/ok, binary `[op, ch_hi, ch_lo, ...payload]`, host
 * replacement (4409, and the old host's viewers go), `OP_DATA` to an unknown
 * channel answered by `OP_CLOSE`, a host `OP_CLOSE`'s optional close code
 * (passed to the viewer only if allow-listed), the 1 MiB payload cap (1009),
 * the channel cap (4429), channel numbers handed out in rotation, an
 * `OP_ACK` for every host message, and the heartbeat auto-response
 * (`ping` → `pong`, never forwarded).
 *
 * Plus a viewer that runs the real ticket-1 initiator.
 */
import { randomBytes } from "node:crypto";
import net, { type AddressInfo } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  FRAME_CHUNK_BYTES,
  SecureChannel,
  base64urlDecode,
  base64urlEncode,
  createInitiator,
  packBatch,
  packBatches,
  unpackBatch,
  verifyHostChallenge,
} from "../../../../src/lib/relay-crypto";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_LIMIT,
  CLOSE_NORMAL,
  CLOSE_NO_HOST,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_TOO_BIG,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_CHANNEL,
  MAX_CHANNELS,
  MAX_RELAY_PAYLOAD_BYTES,
  MIN_CHANNEL,
  OP_ACK,
  OP_CLOSE,
  OP_DATA,
  OP_OPEN,
  PASSTHROUGH_CLOSE_CODES,
  RELAY_ACK_BYTES,
  RELAY_CLOSE_WITH_CODE_BYTES,
  RELAY_HEADER_BYTES,
} from "../../../../src/lib/relay-crypto/protocol";

function toBytes(data: RawData): Uint8Array {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function header(op: number, ch: number): Uint8Array {
  return Uint8Array.of(op, (ch >> 8) & 0xff, ch & 0xff);
}

interface HostEntry {
  ws: WebSocket;
  roomId: string;
  challenge: Uint8Array;
  live: boolean;
}

export class FakeRelay {
  private wss!: WebSocketServer;
  private hosts = new Set<HostEntry>();
  private viewers = new Map<number, WebSocket>();
  private nextCh = MIN_CHANNEL;
  /** Heartbeats received from host sockets. */
  hostPings = 0;
  /** When set, host heartbeats go unanswered (a relay that went quiet). */
  muteHeartbeat = false;
  /** When set, host messages are not acknowledged. */
  muteAcks = false;
  /** Largest payload the host sent (header excluded). */
  maxHostPayload = 0;
  /** Payloads the host sent per channel, in order. */
  readonly hostPayloads = new Map<number, Uint8Array[]>();
  /** Host sockets that completed auth, in order. */
  authCount = 0;
  url = "";

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
    const { port } = this.wss.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${port}`;
    this.wss.on("connection", (ws, req) => {
      const match = /^\/(host|join)\/([A-Za-z0-9_-]{22})$/.exec(req.url ?? "");
      if (!match) {
        ws.close(4404, "not found");
        return;
      }
      if (match[1] === "host") this.acceptHost(ws, match[2]);
      else this.acceptViewer(ws);
    });
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  get liveHost(): HostEntry | null {
    for (const h of this.hosts) if (h.live) return h;
    return null;
  }

  /** Kill the live host's TCP connection without a close frame. */
  dropHost(): void {
    this.liveHost?.ws.terminate();
  }

  private acceptHost(ws: WebSocket, roomId: string): void {
    const entry: HostEntry = {
      ws,
      roomId,
      challenge: randomBytes(32),
      live: false,
    };
    this.hosts.add(entry);
    ws.send(
      JSON.stringify({ t: "challenge", c: base64urlEncode(entry.challenge) }),
    );
    ws.on("message", (data, isBinary) => {
      if (!isBinary && data.toString() === HEARTBEAT_PING) {
        this.hostPings++;
        if (!this.muteHeartbeat) ws.send(HEARTBEAT_PONG);
        return;
      }
      if (!entry.live) {
        if (isBinary) return ws.close(CLOSE_AUTH_FAILED, "auth failed");
        const msg = JSON.parse(data.toString()) as Record<string, string>;
        const ok =
          msg.t === "auth" &&
          verifyHostChallenge(
            base64urlDecode(msg.pub),
            roomId,
            entry.challenge,
            base64urlDecode(msg.sig),
          );
        if (!ok) return ws.close(CLOSE_AUTH_FAILED, "auth failed");
        const previous = this.liveHost;
        if (previous) {
          previous.live = false;
          previous.ws.close(CLOSE_REPLACED, "replaced");
          this.closeAllViewers(CLOSE_NO_HOST);
        }
        entry.live = true;
        this.authCount++;
        ws.send(JSON.stringify({ t: "ok" }));
        return;
      }
      if (!isBinary) return ws.close(1003, "binary only");
      const bytes = toBytes(data);
      const payload = bytes.subarray(RELAY_HEADER_BYTES);
      if (payload.length > MAX_RELAY_PAYLOAD_BYTES) {
        entry.live = false;
        ws.close(CLOSE_TOO_BIG, "too big");
        this.closeAllViewers(CLOSE_NO_HOST);
        return;
      }
      this.maxHostPayload = Math.max(this.maxHostPayload, payload.length);
      const op = bytes[0];
      const ch = (bytes[1] << 8) | bytes[2];
      const viewer = this.viewers.get(ch);
      if ((op === OP_DATA || op === OP_CLOSE) && !this.muteAcks) {
        const ack = new Uint8Array(RELAY_ACK_BYTES);
        ack[0] = OP_ACK;
        new DataView(ack.buffer).setUint32(3, bytes.length, false);
        ws.send(ack);
      }
      if (op === OP_DATA) {
        if (!viewer) return ws.send(header(OP_CLOSE, ch));
        const list = this.hostPayloads.get(ch) ?? [];
        list.push(payload.slice());
        this.hostPayloads.set(ch, list);
        viewer.send(payload);
      } else if (op === OP_CLOSE) {
        let code = CLOSE_NORMAL;
        if (bytes.length === RELAY_CLOSE_WITH_CODE_BYTES) {
          const sent = (bytes[3] << 8) | bytes[4];
          if (PASSTHROUGH_CLOSE_CODES.has(sent)) code = sent;
        } else if (bytes.length !== RELAY_HEADER_BYTES) {
          entry.live = false;
          ws.close(CLOSE_PROTOCOL_ERROR, "bad close");
          this.closeAllViewers(CLOSE_NO_HOST);
          return;
        }
        if (!viewer) return;
        this.viewers.delete(ch);
        viewer.close(code, "closed by host");
      }
    });
    ws.on("close", () => {
      const wasLive = entry.live;
      entry.live = false;
      this.hosts.delete(entry);
      if (wasLive) this.closeAllViewers(CLOSE_NO_HOST);
    });
  }

  /** As `room.ts`: the next number in rotation, skipping open ones. */
  private allocateChannel(): number {
    let ch = this.nextCh;
    while (this.viewers.has(ch)) ch = ch >= MAX_CHANNEL ? MIN_CHANNEL : ch + 1;
    this.nextCh = ch >= MAX_CHANNEL ? MIN_CHANNEL : ch + 1;
    return ch;
  }

  private acceptViewer(ws: WebSocket): void {
    const host = this.liveHost;
    if (!host) return ws.close(CLOSE_NO_HOST, "no host");
    if (this.viewers.size >= MAX_CHANNELS) {
      return ws.close(CLOSE_LIMIT, "too many viewers");
    }
    const ch = this.allocateChannel();
    this.viewers.set(ch, ws);
    host.ws.send(header(OP_OPEN, ch));
    ws.on("message", (data, isBinary) => {
      if (!isBinary && data.toString() === HEARTBEAT_PING) {
        ws.send(HEARTBEAT_PONG);
        return;
      }
      const live = this.liveHost;
      if (!live) return ws.close(CLOSE_NO_HOST, "no host");
      const payload = toBytes(data);
      const out = new Uint8Array(RELAY_HEADER_BYTES + payload.length);
      out.set(header(OP_DATA, ch), 0);
      out.set(payload, RELAY_HEADER_BYTES);
      live.ws.send(out);
    });
    ws.on("close", () => {
      if (this.viewers.get(ch) !== ws) return;
      this.viewers.delete(ch);
      this.liveHost?.ws.send(header(OP_CLOSE, ch));
    });
  }

  private closeAllViewers(code: number): void {
    for (const [ch, ws] of this.viewers) {
      this.viewers.delete(ch);
      ws.close(code, "host gone");
    }
  }
}

/** A browser on the relay: initiator, then batches of sealed frames. */
export class FakeViewer {
  readonly frames: Record<string, unknown>[] = [];
  /** Relay messages received after the handshake. */
  messages = 0;
  readonly closed: Promise<number>;
  private channel: SecureChannel | null = null;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) =>
      ws.on("close", (code) => {
        resolve(code);
        this.wake();
      }),
    );
  }

  /** Connect without saying anything: the host is waiting for message 1. */
  static async connect(url: string, roomId: string): Promise<FakeViewer> {
    const ws = new WebSocket(`${url}/join/${roomId}`);
    ws.binaryType = "nodebuffer";
    const viewer = new FakeViewer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return viewer;
  }

  /** Connect and finish the Noise handshake. */
  static async open(
    url: string,
    roomId: string,
    serverKey: Uint8Array,
  ): Promise<FakeViewer> {
    const viewer = await FakeViewer.connect(url, roomId);
    await viewer.handshake(serverKey);
    return viewer;
  }

  async handshake(serverKey: Uint8Array): Promise<void> {
    const initiator = createInitiator(serverKey);
    const message2 = new Promise<Uint8Array>((resolve, reject) => {
      this.ws.once("message", (data) => resolve(toBytes(data)));
      this.ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
    this.ws.send(initiator.writeMessage1());
    this.channel = new SecureChannel(
      initiator.readMessage2(await message2),
      "viewer",
    );
    this.ws.on("message", (data) => {
      this.messages++;
      for (const chunk of unpackBatch(toBytes(data))) {
        const text = (this.channel as SecureChannel).openFrame(chunk);
        if (text !== null) {
          this.frames.push(JSON.parse(text) as Record<string, unknown>);
        }
      }
      this.wake();
    });
  }

  send(frame: unknown): void {
    const channel = this.channel;
    if (!channel) throw new Error("handshake not done");
    for (const batch of packBatches(
      channel.sealFrame(JSON.stringify(frame)),
      MAX_RELAY_PAYLOAD_BYTES,
    )) {
      this.ws.send(batch);
    }
  }

  /**
   * `count` well-formed, full, non-final frame chunks, each in its own batch:
   * a frame that never ends. Every one decrypts.
   */
  sendUnfinishedFrame(count: number): void {
    const channel = this.channel;
    if (!channel) throw new Error("handshake not done");
    for (let i = 0; i < count; i++) {
      const chunk = new Uint8Array(1 + FRAME_CHUNK_BYTES).fill(0x61);
      chunk[0] = 0x01;
      this.ws.send(packBatch([channel.seal(chunk)]));
    }
  }

  /** Raw bytes, bypassing the channel. */
  sendRaw(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /** A real sealed batch with one ciphertext byte flipped. */
  sendTampered(frame: unknown): void {
    const channel = this.channel;
    if (!channel) throw new Error("handshake not done");
    const [batch] = packBatches(channel.sealFrame(JSON.stringify(frame)));
    batch[batch.length - 1] ^= 0x01;
    this.ws.send(batch);
  }

  async next(
    match: (f: Record<string, unknown>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(match);
      if (found) return found;
      if (this.ws.readyState >= WebSocket.CLOSING) {
        throw new Error("viewer closed before the frame arrived");
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

export interface ThrottledLink {
  /** `ws://` URL that reaches the target through the throttle. */
  url: string;
  close(): Promise<void>;
}

/**
 * A TCP proxy in front of `targetUrl` that passes the client → target
 * direction at `upBytesPerSec` and the other at full speed: the desktop's
 * uplink, for a host socket dialled through it.
 */
export async function throttledLink(
  targetUrl: string,
  upBytesPerSec: number,
): Promise<ThrottledLink> {
  const targetPort = Number(new URL(targetUrl).port);
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("data", (d) => client.write(d));
    const queue: Buffer[] = [];
    let queued = 0;
    const perTick = Math.floor(upBytesPerSec / 100);
    client.on("data", (d: Buffer) => {
      queue.push(d);
      queued += d.length;
      if (queued > 64 * 1024) client.pause();
    });
    const timer = setInterval(() => {
      let budget = perTick;
      while (budget > 0 && queue.length > 0) {
        const head = queue[0];
        const n = Math.min(head.length, budget);
        upstream.write(head.subarray(0, n));
        budget -= n;
        queued -= n;
        if (n === head.length) queue.shift();
        else queue[0] = head.subarray(n);
      }
      if (queued <= 64 * 1024 && client.isPaused()) client.resume();
    }, 10);
    timers.add(timer);
    const end = () => {
      clearInterval(timer);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const t of timers) clearInterval(t);
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
