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

import type { Duplex, Readable, Writable } from "node:stream";
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
 * Ensure the local daemon is running, connect to its control socket, announce
 * it, then pump `io.stdin` into the socket and the socket's output back out to
 * `io.stdout` (with backpressure both ways). Resolves once either direction
 * finishes — a closed socket, or stdin reaching EOF — mirroring
 * `host_unix.rs`'s `select!` between the two copy loops, after tearing down
 * both sides and flushing `io.stdout`. Diagnostics only ever go to
 * `io.stderr`; `io.stdout` carries nothing but the preamble and raw protocol
 * bytes.
 *
 * Rejects without writing anything to `io.stdout` if the daemon cannot be
 * started or reached, so the far end never sees a hello it cannot use.
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
  const socket = await transport.connectControl();

  const hello: BridgeHello = {
    type: "bridgeHello",
    token,
    daemonVersion: process.env.MANOR_VERSION ?? null,
  };
  io.stdout.write(JSON.stringify(hello) + "\n");

  const code = await pump(io, socket, log);
  await teardown(io, socket);
  return code;
}

/**
 * Process wrapper for `manor-host remote-bridge`: run the bridge on this
 * process's stdio and exit once it is done. Exits non-zero (without a hello
 * line) if the daemon could not be reached.
 */
export async function runRemoteBridgeProcess(
  transport: HostTransport = new LocalTransport(),
): Promise<never> {
  let code = 1;
  try {
    code = await runRemoteBridge(undefined, transport);
  } catch (err) {
    try {
      process.stderr.write(`[remote-bridge] ${describeError(err)}\n`);
    } catch {
      // stderr is gone too.
    }
  }
  // Nothing else may keep this process alive: stdin was destroyed and stdout
  // flushed by `teardown`, and the daemon is someone else's process.
  process.exit(code);
}

/**
 * Bidirectional, transparent copy between `io` and `socket`, using `pipe` so
 * a slow reader on either side pauses the writer instead of buffering without
 * bound. Whichever direction finishes first — the socket closing, or stdin
 * reaching EOF (after which `pipe` half-closes the socket) — ends the pump.
 * `EPIPE` on either side is expected once the peer walks away and is
 * swallowed rather than logged.
 */
function pump(
  io: BridgeIO,
  socket: Duplex,
  log: (msg: string) => void,
): Promise<number> {
  const stdinToSocket = new Promise<void>((resolve) => {
    io.stdin.once("end", () => resolve());
    io.stdin.once("close", () => resolve());
    io.stdin.on("error", (err) => {
      if (!isEpipe(err)) log(`stdin error: ${describeError(err)}`);
      resolve();
    });
  });

  const socketToStdout = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.on("error", (err) => {
      if (!isEpipe(err)) log(`socket error: ${describeError(err)}`);
      resolve();
    });
  });

  io.stdout.on("error", (err) => {
    if (!isEpipe(err)) log(`stdout error: ${describeError(err)}`);
  });

  io.stdin.pipe(socket);
  socket.pipe(io.stdout, { end: false });

  return Promise.race([stdinToSocket, socketToStdout]).then(() => 0);
}

/** How long `teardown` waits for stdout to flush before giving up on it. */
const STDOUT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Stop both pumps and flush stdout. Destroying stdin matters for the real
 * process: a live `process.stdin` keeps the event loop — and so the ssh
 * session — alive after the daemon has gone.
 */
async function teardown(io: BridgeIO, socket: Duplex): Promise<void> {
  io.stdin.unpipe(socket);
  socket.unpipe(io.stdout);
  io.stdin.destroy();
  socket.destroy();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STDOUT_FLUSH_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (io.stdout.writableFinished || io.stdout.destroyed) {
      done();
      return;
    }
    io.stdout.once("error", done);
    io.stdout.once("close", done);
    io.stdout.end(done);
  });
}
