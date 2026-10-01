/** Test clients for the relay: a queued WebSocket and a host that signs in. */
import { SELF } from "cloudflare:test";

import { OP_ACK } from "../../src/lib/relay-crypto/protocol";
import {
  base64urlDecode,
  base64urlEncode,
  generateRelayIdentity,
  roomIdFor,
  signHostChallenge,
  type RelayIdentity,
} from "../../src/lib/relay-crypto";

type Message = string | ArrayBuffer;

export interface Closed {
  code: number;
  reason: string;
}

const ORIGIN = "https://relay.test";
let ipCounter = 0;

/** A distinct client IP, so tests do not share a join rate-limit bucket. */
export function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class TestSocket {
  private readonly queue: Message[] = [];
  private readonly waiters: Array<(m: Message) => void> = [];
  private closedInfo: Closed | null = null;
  readonly closed: Promise<Closed>;
  /**
   * `OP_ACK`s the room sent, as the byte counts they carry: on a host socket
   * (`host`), kept out of `next()` so host tests read the room's other
   * messages as before.
   */
  readonly acks: number[] = [];

  constructor(
    readonly ws: WebSocket,
    host = false,
  ) {
    // The Workers runtime follows the standard and defaults to Blob.
    ws.binaryType = "arraybuffer";
    ws.accept();
    ws.addEventListener("message", (e) => {
      const data = e.data as Message;
      if (
        host &&
        data instanceof ArrayBuffer &&
        new Uint8Array(data)[0] === OP_ACK
      ) {
        this.acks.push(new DataView(data).getUint32(3, false));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(data);
      else this.queue.push(data);
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (e) => {
        this.closedInfo = { code: e.code, reason: e.reason };
        resolve(this.closedInfo);
      });
    });
  }

  /** The next message; rejects if the socket closes first. */
  next(ms = 2000): Promise<Message> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const message = new Promise<Message>((resolve) =>
      this.waiters.push(resolve),
    );
    const closed = this.closed.then((c) => {
      throw new Error(`socket closed ${c.code} ${c.reason}`);
    });
    return withTimeout(Promise.race([message, closed]), ms, "a message");
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const m = await this.next();
    if (typeof m !== "string") throw new Error("expected a text message");
    return JSON.parse(m) as Record<string, unknown>;
  }

  async nextBytes(): Promise<Uint8Array> {
    const m = await this.next();
    if (typeof m === "string") throw new Error(`expected binary, got ${m}`);
    return new Uint8Array(m);
  }

  /** Resolves with the close code, failing if the socket stays open. */
  waitClosed(ms = 2000): Promise<Closed> {
    return withTimeout(this.closed, ms, "close");
  }

  isClosed(): boolean {
    return this.closedInfo !== null;
  }

  /** True if nothing arrives within `ms`. */
  async quiet(ms = 100): Promise<boolean> {
    if (this.queue.length > 0) return false;
    await new Promise((r) => setTimeout(r, ms));
    return this.queue.length === 0;
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  close(code = 1000): void {
    this.ws.close(code, "bye");
  }
}

export async function upgrade(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(ORIGIN + path, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

async function connect(
  path: string,
  headers: Record<string, string> = {},
): Promise<TestSocket> {
  const res = await upgrade(path, headers);
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected 101, got ${res.status}`);
  }
  return new TestSocket(res.webSocket, path.startsWith("/host/"));
}

export function newIdentity(): { identity: RelayIdentity; roomId: string } {
  const identity = generateRelayIdentity();
  return { identity, roomId: roomIdFor(identity.ed25519.pub) };
}

/** Opens `/host/<roomId>` and returns the socket and its challenge bytes. */
export async function openHost(
  roomId: string,
): Promise<{ sock: TestSocket; challenge: Uint8Array }> {
  const sock = await connect(`/host/${roomId}`, {
    "CF-Connecting-IP": freshIp(),
  });
  const msg = await sock.nextJson();
  if (msg.t !== "challenge" || typeof msg.c !== "string") {
    throw new Error(`expected a challenge, got ${JSON.stringify(msg)}`);
  }
  return { sock, challenge: base64urlDecode(msg.c) };
}

export function authMessage(
  identity: RelayIdentity,
  roomId: string,
  challenge: Uint8Array,
): string {
  return JSON.stringify({
    t: "auth",
    pub: base64urlEncode(identity.ed25519.pub),
    sig: base64urlEncode(
      signHostChallenge(identity.ed25519.priv, roomId, challenge),
    ),
  });
}

/** A host that has authenticated: `{t:"ok"}` already consumed. */
export async function liveHost(
  identity: RelayIdentity,
  roomId: string,
): Promise<TestSocket> {
  const { sock, challenge } = await openHost(roomId);
  sock.send(authMessage(identity, roomId, challenge));
  const ok = await sock.nextJson();
  if (ok.t !== "ok") throw new Error(`expected ok, got ${JSON.stringify(ok)}`);
  return sock;
}

export function join(roomId: string, ip = freshIp()): Promise<TestSocket> {
  return connect(`/join/${roomId}`, { "CF-Connecting-IP": ip });
}

export function frame(
  op: number,
  ch: number,
  payload: number[] = [],
): Uint8Array {
  return Uint8Array.of(op, ch >> 8, ch & 0xff, ...payload);
}
