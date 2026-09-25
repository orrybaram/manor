/**
 * remote-bridge — the remote end of an ssh stdio bridge (mirrors herdr's
 * `src/remote/host_unix.rs`).
 *
 * Invoked as `manor-host remote-bridge` on the far side of an ssh connection.
 * It makes sure a daemon is running on *this* machine (reusing the same
 * spawn/detect path a local client uses), announces itself with a one-line
 * NDJSON preamble on stdout, then pumps stdin/stdout transparently against
 * the daemon's control socket. `SshTransport` (client side, a later ticket)
 * reads that preamble and hands the rest of the connection to
 * `TerminalHostClient` unchanged — from there it cannot tell local from
 * remote.
 *
 * Kept out of `index.ts` so it can be exercised directly in tests, against an
 * injected transport and injected stdio, without spawning a real process.
 */

import type { Readable, Writable } from "node:stream";
import type { Duplex } from "node:stream";
import { LocalTransport } from "./transport-local";
import type { HostTransport } from "./transport";

/** The stdio surface the bridge pumps. Injectable so tests do not need real pipes. */
export interface BridgeIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** The one-line JSON preamble the bridge writes to stdout before pumping bytes. */
interface BridgeHello {
  type: "bridgeHello";
  token: string;
  daemonVersion: string | null;
}

function isEpipe(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "EPIPE"
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ensure the local daemon is running, announce it, then pump `io.stdin` into
 * the daemon's control socket and the socket's output back out to
 * `io.stdout`. Resolves once either direction finishes — a closed socket, or
 * stdin reaching EOF — mirroring `host_unix.rs`'s `select!` between the two
 * copy loops. Diagnostics only ever go to `io.stderr`; `io.stdout` carries
 * nothing but the preamble and raw protocol bytes.
 */
export async function runRemoteBridge(
  io: BridgeIO = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  transport: HostTransport = new LocalTransport(),
): Promise<number> {
  const log = (msg: string): void => {
    try {
      io.stderr.write(`[remote-bridge] ${msg}\n`);
    } catch {
      // stderr may already be gone; nothing else to do about it.
    }
  };

  await transport.ensureRunning();
  const token = await transport.authToken();

  const hello: BridgeHello = {
    type: "bridgeHello",
    token,
    daemonVersion: process.env.MANOR_VERSION ?? null,
  };
  io.stdout.write(JSON.stringify(hello) + "\n");

  const socket = await transport.connectControl();
  return pump(io, socket, log);
}

/**
 * Bidirectional, transparent copy between `io` and `socket`. Each direction
 * is its own loop; whichever finishes first — the socket closing, or stdin
 * reaching EOF (after which the socket's write side is half-closed) — ends
 * the pump. `EPIPE` on either side is expected once the peer walks away and
 * is swallowed rather than logged.
 */
function pump(
  io: BridgeIO,
  socket: Duplex,
  log: (msg: string) => void,
): Promise<number> {
  const stdinToSocket = new Promise<void>((resolve) => {
    io.stdin.on("data", (chunk: Buffer) => {
      if (!socket.writable) return;
      try {
        socket.write(chunk);
      } catch (err) {
        if (!isEpipe(err)) log(`stdin -> socket: ${describeError(err)}`);
      }
    });
    io.stdin.on("end", () => {
      try {
        socket.end();
      } catch {
        // Already closed.
      }
      resolve();
    });
    io.stdin.on("error", (err) => {
      if (!isEpipe(err)) log(`stdin error: ${describeError(err)}`);
      resolve();
    });
  });

  const socketToStdout = new Promise<void>((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      try {
        io.stdout.write(chunk);
      } catch (err) {
        if (!isEpipe(err)) log(`socket -> stdout: ${describeError(err)}`);
      }
    });
    socket.on("close", () => resolve());
    socket.on("error", (err) => {
      if (!isEpipe(err)) log(`socket error: ${describeError(err)}`);
      resolve();
    });
  });

  io.stdout.on("error", (err) => {
    if (!isEpipe(err)) log(`stdout error: ${describeError(err)}`);
  });

  return Promise.race([stdinToSocket, socketToStdout]).then(() => 0);
}
