/**
 * server-bridge — the remote end of the desktop's owner channel to a host
 * server (ADR-225 D4), modelled on `remote-bridge` (`./bridge.ts`).
 *
 * Invoked as `manor-host server-bridge` on the far side of an ssh
 * connection (`ssh -T <target> 'exec manor-host server-bridge'`). It reads
 * the host server's 0600 owner token (`~/.manor/remote/server/owner-token`),
 * connects to the server's unix socket (`server.sock`), writes the owner
 * hello `{"type":"hello","token":…}` on the desktop's behalf (the token
 * alone makes it the owner), and then pumps stdin/stdout transparently
 * against the socket. SSH is the
 * authentication: whoever can run this command as the box's user can read
 * the token anyway.
 *
 * Framing on the stream is the socket's, untouched: newline-delimited JSON
 * bridge frames (`host-server/socket.ts`). Unlike `remote-bridge` it writes
 * no preamble of its own — the first line the desktop reads is the server's
 * hello reply (or its `{"kind":"close",…}` line).
 *
 * Fails before writing anything to stdout, with one line on stderr and a
 * non-zero exit, when there is no server to reach (no token, or nothing
 * listening on the socket): the desktop reads that as "no host server here"
 * and carries on without one.
 *
 * Kept out of `index.ts` so it can be exercised directly in tests, against
 * injected paths and stdio, without spawning a real process.
 */

import fs from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { errorMessage } from "../lib/errors";
import {
  hostServerPaths,
  remoteServerDir,
  type HostServerPaths,
} from "../paths";
import { ensureServerRunning } from "../host-server/lifecycle";
import { pump, teardown, type BridgeIO } from "./bridge";

/** The exit code for "there is no host server running on this box". */
const SERVER_NOT_RUNNING_EXIT = 3;

/** No host server to reach: no owner token, or nothing on its socket. */
class HostServerNotRunningError extends Error {
  constructor(detail: string) {
    super(`the host server is not running on this box (${detail})`);
    this.name = "HostServerNotRunningError";
  }
}

export interface ServerBridgeOptions {
  /** Where the server's socket and token are. Defaults to `remoteServerDir()`. */
  paths?: Pick<HostServerPaths, "socket" | "ownerToken">;
  /**
   * Make sure a host server is running, starting one if not, before the
   * token is read. Defaults to `ensureServerRunning` (`../host-server/lifecycle`).
   */
  ensureServerRunning?: () => Promise<void>;
}

/** The owner token, or `HostServerNotRunningError` when there is none. */
function readOwnerToken(file: string): string {
  let token: string;
  try {
    token = fs.readFileSync(file, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HostServerNotRunningError(`no owner token at ${file}`);
    }
    throw err;
  }
  if (!token) throw new HostServerNotRunningError(`${file} is empty`);
  return token;
}

/** A connection to the server's socket; a missing or dead one is "not running". */
function connectSocket(socketPath: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = (err: NodeJS.ErrnoException): void => {
      socket.destroy();
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new HostServerNotRunningError(`nothing listening on ${socketPath}`));
      } else {
        reject(err);
      }
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Ensure the server, read its token, connect, say the owner's hello, then
 * pump `io` against the socket until either side ends. Rejects without
 * writing to `io.stdout` when there is no server to reach.
 */
export async function runServerBridge(
  io: BridgeIO = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  opts: ServerBridgeOptions = {},
): Promise<number> {
  const log = (msg: string): void => {
    try {
      io.stderr.write(`[server-bridge] ${msg}\n`);
    } catch {
      // stderr may already be gone.
    }
  };
  const paths = opts.paths ?? hostServerPaths(remoteServerDir());

  await (opts.ensureServerRunning ?? ensureServerRunning)();
  const token = readOwnerToken(paths.ownerToken);
  const socket = await connectSocket(paths.socket);

  // The hello goes to the server, not to stdout: the desktop's first line
  // is the server's reply to it.
  socket.write(JSON.stringify({ type: "hello", token }) + "\n");

  const code = await pump(io, socket, log);
  await teardown(io, socket);
  return code;
}

/**
 * Process wrapper for `manor-host server-bridge`: run the bridge on this
 * process's stdio and exit once it is done — non-zero, with one stderr
 * line, when there is no server to reach.
 */
export async function runServerBridgeProcess(): Promise<never> {
  let code = 1;
  try {
    code = await runServerBridge();
  } catch (err) {
    if (err instanceof HostServerNotRunningError) code = SERVER_NOT_RUNNING_EXIT;
    try {
      process.stderr.write(`[server-bridge] ${errorMessage(err)}\n`);
    } catch {
      // stderr is gone too.
    }
  }
  process.exit(code);
}
