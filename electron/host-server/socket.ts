/**
 * The host server's unix socket (ADR-218 D1, D4): `dataDir/server.sock`,
 * mode 0600, where `manor-host server-bridge` (`terminal-host/server-bridge.ts`)
 * pipes the desktop's owner channel.
 *
 * **Framing: newline-delimited JSON**, one bridge frame per line — the same
 * framing as the daemon's sockets and `remote-bridge`'s stdio, so the
 * desktop's end can reuse `terminal-host/line-reader.ts` and an ssh channel
 * carries it untouched. `JSON.stringify` never writes a raw newline, so a
 * line is always a whole frame. The frames are the bridge's own
 * (`bridge/types.ts`): a `hello`, then `invoke` / `subscribe` /
 * `unsubscribe` from the client and `result` / `event` from the server.
 *
 * A WebSocket's close code has no counterpart on a stream, so closing sends
 * one last line, `{"kind":"close","code":…,"reason":…}`, and ends the stream:
 * 4401 still reads as "your token is wrong".
 *
 * **Authentication is the hello**, exactly as on the relay
 * (`transports/ws.ts`): `{"type":"hello","token":<owner-token>,"role":"owner"}` first,
 * within the hello timeout, or the socket is closed. The token is the 0600
 * `dataDir/owner-token`; whoever can read it is this box's user, and that
 * user already reaches every terminal here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { FrameSocket } from "../bridge/transports/frame-socket";
import type {
  BridgeAuthenticator,
  WsBridgeServer,
} from "../bridge/transports/ws";
import { CLOSE_UNAUTHORIZED } from "../bridge/types";
import { createLineReader } from "../terminal-host/line-reader";

/** A bridge `FrameSocket` over one NDJSON stream. */
export function ndjsonFrameSocket(socket: net.Socket): FrameSocket {
  let closed = false;
  const isOpen = () => !closed && !socket.destroyed && socket.writable;
  return {
    get open() {
      return isOpen();
    },
    send(text) {
      if (!isOpen()) return;
      socket.write(text + "\n");
    },
    close(code, reason) {
      if (!isOpen()) return;
      closed = true;
      socket.end(JSON.stringify({ kind: "close", code, reason }) + "\n");
    },
    terminate() {
      closed = true;
      socket.destroy();
    },
    onMessage(cb) {
      socket.on("data", createLineReader(cb));
    },
    onClose(cb) {
      socket.on("close", () => {
        closed = true;
        cb();
      });
    },
  };
}

/** A 32-byte owner token, as hex. */
export function newOwnerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Write `dataDir/owner-token`, mode 0600, replacing any token from an earlier
 * run: a token lives exactly as long as the server that minted it.
 */
export function writeOwnerToken(file: string, token: string): void {
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

/**
 * The hello check for the owner socket (ADR-218 D4): the token must be the
 * owner token, compared in constant time, and a hello that names a `role`
 * must name `owner` (what `manor-host server-bridge` sends). Answers
 * `caller: "owner"`, which the host server lets call `LOCAL_ONLY` methods
 * such as pairing and the manifest sync.
 */
export function ownerTokenAuthenticator(token: string): BridgeAuthenticator {
  const expected = digest(token);
  return (presented, hello) => {
    if (typeof presented !== "string")
      return { ok: false, code: CLOSE_UNAUTHORIZED };
    if (hello?.role !== undefined && hello.role !== "owner")
      return { ok: false, code: CLOSE_UNAUTHORIZED };
    return crypto.timingSafeEqual(digest(presented), expected)
      ? { ok: true, caller: "owner" }
      : { ok: false, code: CLOSE_UNAUTHORIZED };
  };
}

function trySetUmask(mask: number): number | null {
  try {
    return process.umask(mask);
  } catch {
    return null;
  }
}

export interface HostSocketListener {
  close(): Promise<void>;
}

/**
 * Listen on `socketPath` and hand every connection to `transport`'s hello
 * gate. A stale socket file from a server that died is removed first; the
 * caller has already made sure no live server owns it (the pid file).
 */
export async function listenHostSocket(
  socketPath: string,
  transport: WsBridgeServer,
  authenticate: BridgeAuthenticator,
): Promise<HostSocketListener> {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // None left behind.
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A peer that vanishes mid-write is a closed connection, not a crash.
    socket.on("error", () => socket.destroy());
    transport.attach(ndjsonFrameSocket(socket), authenticate);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 0600 from birth, so there is no window in which another user could
    // connect. (`umask` is refused inside a worker thread; the chmod below
    // still applies there.)
    const previous = trySetUmask(0o177);
    try {
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      if (previous !== null) trySetUmask(previous);
    }
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Already gone.
          }
          resolve();
        });
      }),
  };
}
