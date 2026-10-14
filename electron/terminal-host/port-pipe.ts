/**
 * port-pipe — the box's end of a port forward over an exec transport
 * (ADR-229 D3).
 *
 * Invoked as `manor-host port-pipe <port> [--host ::1]` through the exec
 * prefix (`kubectl exec -i … -- sh -c 'exec manor-host port-pipe 5173'`),
 * once per connection the desktop accepts on its local end
 * (`CommandHostProvider.forwardPort`). It connects to `127.0.0.1:<port>` —
 * or `[::1]:<port>` for a server listening only there — and pumps
 * stdin/stdout against the socket until either side closes.
 *
 * Only the box's loopback can be reached: a forward never reaches past the
 * box, as with ssh's `-L 127.0.0.1:<l>:127.0.0.1:<r>` (`forwardSpec`).
 *
 * Fails before writing anything to stdout, with one line on stderr and a
 * non-zero exit, when the connect fails; the desktop closes its local
 * connection then.
 *
 * Kept out of `index.ts` so it can be exercised directly in tests, against
 * injected stdio, without spawning a real process.
 */

import net from "node:net";
import { errorMessage } from "../lib/errors";
import { pump, teardown, type BridgeIO } from "./bridge";

/** The box addresses a pipe may reach: only ever its loopback. */
type PipeLoopback = "127.0.0.1" | "::1";

export interface PortPipeTarget {
  port: number;
  host: PipeLoopback;
}

/**
 * Read `<port> [--host <loopback>]`. The port must be a decimal integer in
 * 1–65535 (as `assertPort` checks a forward's); the host, when given,
 * `127.0.0.1` or `::1` (`[::1]` too). Throws on anything else.
 */
export function parsePortPipeArgs(args: readonly string[]): PortPipeTarget {
  let portArg: string | undefined;
  let host: PipeLoopback = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host") {
      const value = args[++i];
      if (value === "127.0.0.1") host = "127.0.0.1";
      else if (value === "::1" || value === "[::1]") host = "::1";
      else throw new Error(`port-pipe only reaches loopback (127.0.0.1 or ::1), not ${JSON.stringify(value ?? "")}`);
    } else if (portArg === undefined) {
      portArg = arg;
    } else {
      throw new Error(`Unexpected port-pipe argument: ${JSON.stringify(arg)}`);
    }
  }
  if (portArg === undefined) throw new Error("Usage: manor-host port-pipe <port> [--host ::1]");
  const port = /^\d+$/.test(portArg) ? Number(portArg) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portArg}`);
  }
  return { port, host };
}

/** Connect to the target; rejects on any connect failure. */
function connect({ port, host }: PortPipeTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Connect to `target` and pump `io` against it until either side closes.
 * Rejects without writing to `io.stdout` when the connect fails.
 */
export async function runPortPipe(
  target: PortPipeTarget,
  io: BridgeIO = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const log = (msg: string): void => {
    try {
      io.stderr.write(`[port-pipe] ${msg}\n`);
    } catch {
      // stderr may already be gone.
    }
  };
  const socket = await connect(target);
  const code = await pump(io, socket, log);
  await teardown(io, socket);
  return code;
}

/**
 * Process wrapper for `manor-host port-pipe <port> [--host ::1]`: run the
 * pipe on this process's stdio and exit once it is done — non-zero, with one
 * stderr line, on bad arguments or a failed connect. `args` is what followed
 * `port-pipe` on the command line.
 */
export async function runPortPipeProcess(args: readonly string[]): Promise<never> {
  let code = 1;
  try {
    code = await runPortPipe(parsePortPipeArgs(args));
  } catch (err) {
    try {
      process.stderr.write(`[port-pipe] ${errorMessage(err)}\n`);
    } catch {
      // stderr is gone too.
    }
  }
  process.exit(code);
}
