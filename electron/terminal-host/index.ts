#!/usr/bin/env node
/**
 * Terminal Host Daemon — entry point.
 *
 * Runs as a detached Node.js process (ELECTRON_RUN_AS_NODE=1).
 * Listens on a Unix domain socket for control and stream connections.
 * Auth via shared token file.
 */

import "./xterm-env-polyfill";
import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { TerminalHost } from "./terminal-host";
import { TERMINAL_HOST_PROTOCOL } from "./types";
import { PTY_SUBPROCESS_PROTOCOL } from "./pty-subprocess-ipc";
import type {
  ControlRequest,
  ControlResponse,
  StreamCommand,
  StreamEvent,
} from "./types";
import { runRemoteBridgeProcess } from "./bridge";
import { LocalTransport } from "./transport-local";
import { ExecRunner, runExec } from "./exec-runner";
import { createSerializedHandler } from "./control-queue";
import { localRole, remoteRole, type DaemonRole } from "./daemon-role";
import { errorMessage } from "../lib/errors";

const daemonVersion = process.env.MANOR_VERSION;

/** `readFile` refuses files larger than this rather than buffering them. */
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

function log(msg: string): void {
  const ts = new Date().toISOString();
  try {
    process.stderr.write(`[terminal-host ${ts}] ${msg}\n`);
  } catch {
    // stderr is gone (see installDaemonSignalHandlers); logging is best-effort.
  }
}

// ── Connections ──

/**
 * One client socket and everything the daemon keeps for it. Its first line
 * decides `kind`: `{"connectionType":"stream", token}` makes it a stream
 * socket, anything else a control socket.
 */
class Connection {
  kind: "control" | "stream" | null = null;
  authenticated = false;
  /**
   * execId → child bookkeeping for this stream socket's `execStream`s, so a
   * dropped connection kills exactly its own children.
   */
  private execRunner: ExecRunner | undefined;
  /**
   * Aborters for this control socket's in-flight `exec` requests, so a socket
   * that closes mid-exec kills the command it started instead of leaving it
   * running.
   */
  readonly inFlightExecs = new Set<AbortController>();

  constructor(readonly socket: net.Socket) {}

  getExecRunner(): ExecRunner {
    if (!this.execRunner) {
      const runner = new ExecRunner();
      // Streamed exec output is paused whenever the socket's write buffer is
      // full (see sendStreamEvent's return value) and resumed once it drains.
      this.socket.on("drain", () => runner.resumeOutput());
      this.execRunner = runner;
    }
    return this.execRunner;
  }

  cancelExec(execId: string): void {
    this.execRunner?.cancel(execId);
  }

  /**
   * Kill every child this connection started — a dropped connection (e.g. a
   * dropped ssh session) must not leak processes.
   */
  dispose(): void {
    this.execRunner?.disposeAll();
    this.execRunner = undefined;
    for (const aborter of this.inFlightExecs) aborter.abort();
    this.inFlightExecs.clear();
  }
}

/** What the request handlers share: the role, the sessions, the sockets. */
interface Daemon {
  role: DaemonRole;
  host: TerminalHost;
  connections: Map<net.Socket, Connection>;
}

// ── Setup ──

function setup(role: DaemonRole): void {
  const { dir, token: tokenPath, pid, socket } = role.paths;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Generate auth token
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });

  // Write PID file
  fs.writeFileSync(pid, String(process.pid), { mode: 0o600 });

  // Clean up stale socket
  try {
    fs.unlinkSync(socket);
  } catch {
    // doesn't exist
  }
}

function readToken(role: DaemonRole): string {
  return fs.readFileSync(role.paths.token, "utf-8").trim();
}

// ── Control socket handling ──

/** Answer one control request. The caller sends the reply with its requestId. */
async function handleControlMessage(
  d: Daemon,
  conn: Connection,
  request: ControlRequest,
): Promise<ControlResponse> {
  const { host, role } = d;

  // Auth check (except for auth request itself)
  if (request.type !== "auth" && !conn.authenticated) {
    return { type: "error", message: "Not authenticated" };
  }

  switch (request.type) {
    case "auth": {
      if (request.token !== readToken(role)) {
        return { type: "error", message: "Invalid token" };
      }
      conn.authenticated = true;
      return { type: "authOk", version: daemonVersion };
    }

    case "create": {
      try {
        const session = host.create(
          request.sessionId,
          request.cwd,
          request.cols,
          request.rows,
          request.shellArgs,
          request.prewarmed,
          request.env,
        );
        return { type: "created", session };
      } catch (err) {
        log(`Failed to create session ${request.sessionId}: ${err}`);
        return { type: "error", message: `Create failed: ${errorMessage(err)}` };
      }
    }

    case "attach": {
      const snapshot = await host.attach(request.sessionId, conn.socket);
      return snapshot
        ? { type: "attached", snapshot }
        : { type: "notFound", sessionId: request.sessionId };
    }

    case "detach":
      host.detach(request.sessionId, conn.socket);
      return { type: "detached" };

    case "resize":
      await host.resize(request.sessionId, request.cols, request.rows);
      return { type: "resized" };

    case "kill":
      await host.kill(request.sessionId);
      return { type: "killed" };

    case "writeAfterReady":
      return host.writeAfterReady(request.sessionId, request.data)
        ? { type: "writeQueued" }
        : { type: "error", message: `Session ${request.sessionId} not found` };

    case "getSnapshot": {
      const snapshot = await host.getSnapshot(request.sessionId);
      if (!snapshot) {
        // A fact, not a failure — the caller decides whether to spawn a shell.
        return { type: "notFound", sessionId: request.sessionId };
      }
      host.clearPrewarmed(request.sessionId);
      return { type: "snapshot", snapshot };
    }

    case "getPaneFacts":
      // Null for an unknown session: main resyncs every pane it knows of
      // after a reconnect, and a missing one simply has no facts (ADR-184 §3).
      return { type: "paneFacts", facts: host.getPaneFacts(request.sessionId) };

    case "disposeDead":
      host.disposeDeadSessions();
      return { type: "disposedDead" };

    case "listSessions":
      return { type: "sessions", sessions: host.listSessions() };

    case "ping":
      return { type: "pong" };

    case "updateEnv": {
      // Update daemon process.env so new PTY sessions inherit fresh values.
      // This is needed when the Electron app restarts (new hook port, etc.)
      // but reconnects to an existing daemon. The role drops keys that mean
      // nothing on this host (ADR-178 §2).
      for (const [key, value] of Object.entries(request.env)) {
        if (role.acceptsEnvKey(key)) process.env[key] = value;
      }
      return { type: "envUpdated" };
    }

    // exec and readFile are dispatched outside the serial queue (see
    // control-queue.ts) — their responses may go out after later requests'.
    case "exec": {
      log(`exec: ${request.cmd}`);
      const aborter = new AbortController();
      conn.inFlightExecs.add(aborter);
      try {
        const result = await runExec(request.cmd, request.args, {
          cwd: request.cwd,
          timeout: request.timeout,
          maxBuffer: request.maxBuffer,
          signal: aborter.signal,
        });
        return {
          type: "execResult",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } finally {
        conn.inFlightExecs.delete(aborter);
      }
    }

    case "readFile": {
      try {
        const { size } = await fsStat(request.path);
        if (size > MAX_READ_FILE_BYTES) {
          throw new Error(
            `file is ${size} bytes, over the ${MAX_READ_FILE_BYTES}-byte limit`,
          );
        }
        const contents = await fsReadFile(request.path, "utf-8");
        return { type: "fileContents", contents };
      } catch (err) {
        return { type: "error", message: `readFile failed: ${errorMessage(err)}` };
      }
    }

    case "bootstrap": {
      try {
        const { agents, warnings } = await role.bootstrap();
        return {
          type: "bootstrapped",
          agents,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (err) {
        const message = errorMessage(err);
        log(`bootstrap failed: ${message}`);
        return { type: "error", message };
      }
    }

    case "replayHooks": {
      const journal = role.hookJournal;
      if (!journal) {
        return { type: "error", message: "this daemon has no hook journal" };
      }
      return {
        type: "hookReplay",
        entries: request.headOnly
          ? []
          : journal.since(Number(request.sinceSeq) || 0),
        lastSeq: journal.lastSeq,
        epoch: journal.epoch,
      };
    }

    case "handshake":
      // Client sends its app version; daemon replies with its own plus the
      // two protocols it speaks. The client replaces the daemon only when
      // one of those protocols does not match its own — the app version is
      // just for diagnostics/logging now (ADR-185 §B, see `isDaemonStale`).
      return {
        type: "handshake",
        daemonVersion: daemonVersion ?? "unknown",
        protocol: TERMINAL_HOST_PROTOCOL,
        ptyProtocol: PTY_SUBPROCESS_PROTOCOL,
      };

    default: {
      // A newer client asking for something this daemon does not know. Answer
      // rather than stay silent, or the client waits out its timeout and then
      // drops the whole connection.
      const unknownType = (request as { type?: unknown }).type;
      return {
        type: "error",
        message: `unknown request type: ${String(unknownType)}`,
      };
    }
  }
}

async function handleStreamMessage(
  d: Daemon,
  conn: Connection,
  line: string,
): Promise<void> {
  let command: StreamCommand;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  if (!conn.authenticated) return;

  const { host } = d;
  const { socket } = conn;
  switch (command.type) {
    case "write":
      host.write(command.sessionId, command.data);
      break;
    case "subscribe":
      await host.attach(command.sessionId, socket);
      break;
    case "unsubscribe":
      host.detach(command.sessionId, socket);
      break;
    case "execStream": {
      log(`execStream: ${command.cmd}`);
      conn.getExecRunner().start(
        command.execId,
        command.cmd,
        command.args,
        { cwd: command.cwd, env: command.env },
        {
          onStdout: (execId, data) =>
            sendStreamEvent(socket, { type: "execStdout", execId, data }),
          onStderr: (execId, data) =>
            sendStreamEvent(socket, { type: "execStderr", execId, data }),
          onExit: (execId, exitCode) =>
            sendStreamEvent(socket, { type: "execExit", execId, exitCode }),
        },
      );
      break;
    }
    case "execCancel":
      conn.cancelExec(command.execId);
      break;
  }
}

/**
 * Write one stream event. Returns `false` when the socket's write buffer is
 * full and the caller should hold off until `drain` (exec output uses this
 * for backpressure; everything else ignores it).
 */
function sendStreamEvent(socket: net.Socket, event: StreamEvent): boolean {
  try {
    return socket.write(JSON.stringify(event) + "\n");
  } catch {
    // socket may be closed
    return true;
  }
}

/**
 * Write one control reply, echoing the request's id. `requestId` is only
 * missing for a line the daemon could not read an id out of (see
 * `Envelope` in types.ts).
 */
function sendResponse(
  socket: net.Socket,
  response: ControlResponse,
  requestId: string | undefined,
): void {
  try {
    const payload = requestId !== undefined ? { ...response, requestId } : response;
    socket.write(JSON.stringify(payload) + "\n");
  } catch {
    // socket may be closed
  }
}

// ── NDJSON line parser ──

function createLineParser(
  onLine: (line: string) => void,
): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // Keep incomplete line
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };
}

function createControlHandler(d: Daemon, conn: Connection): (line: string) => void {
  const { socket } = conn;
  return createSerializedHandler(
    async (req) => {
      const response = await handleControlMessage(d, conn, req);
      sendResponse(socket, response, req.requestId);
    },
    (requestId, err) => {
      const message = errorMessage(err);
      sendResponse(
        socket,
        { type: "error", message: `Internal error: ${message}` },
        requestId,
      );
      log(`Error handling control message: ${message}`);
    },
    (requestId) =>
      sendResponse(socket, { type: "error", message: "Invalid JSON" }, requestId),
  );
}

// ── Server ──

interface DaemonServer {
  /** Stop serving and release what the role holds. Sessions are the caller's. */
  close(): void;
  host: TerminalHost;
}

function startServer(role: DaemonRole): DaemonServer {
  setup(role);
  const d: Daemon = {
    role,
    host: new TerminalHost(),
    connections: new Map(),
  };
  const socketPath = role.paths.socket;

  const server = net.createServer((socket) => {
    log("Client connected");
    const conn = new Connection(socket);
    d.connections.set(socket, conn);
    let lineHandler: ((line: string) => void) | null = null;

    const initialParser = createLineParser((line) => {
      if (conn.kind !== null) {
        lineHandler?.(line);
        return;
      }

      let msg: { connectionType?: unknown; token?: unknown } | null = null;
      try {
        msg = JSON.parse(line);
      } catch {
        // Not JSON — let the control handler answer it.
      }
      if (msg?.connectionType === "stream") {
        conn.kind = "stream";
        lineHandler = (l) => void handleStreamMessage(d, conn, l);
        // Stream sockets authenticate with the token in their init message.
        if (msg.token && msg.token === readToken(role)) conn.authenticated = true;
      } else {
        conn.kind = "control";
        lineHandler = createControlHandler(d, conn);
        // Process this line as a control message (could be auth)
        lineHandler(line);
      }
    });

    socket.on("data", initialParser);

    socket.on("close", () => {
      log("Client disconnected");
      d.host.detachAllFromSocket(socket);
      conn.dispose();
      d.connections.delete(socket);
    });

    socket.on("error", (err) => {
      log(`Socket error: ${err.message}`);
    });
  });

  server.listen(socketPath, () => {
    log(`Listening on ${socketPath}`);
    // Make socket accessible
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // ignore
    }
  });

  role.onStartup({
    // Hook events go to every authenticated stream socket, subscribed to a
    // session or not (ADR-178 §2).
    onHookEntry: (entry) => {
      const event: StreamEvent = {
        type: "hookEvent",
        seq: entry.seq,
        payload: entry.payload,
      };
      for (const conn of d.connections.values()) {
        if (conn.kind === "stream" && conn.authenticated) {
          sendStreamEvent(conn.socket, event);
        }
      }
    },
  });

  return {
    host: d.host,
    close: () => {
      role.shutdown();
      server.close();
    },
  };
}

// ── Graceful shutdown ──

function shutdown(role: DaemonRole, server: DaemonServer | null): never {
  log("Shutting down...");
  if (server) {
    server.close();
    server.host.disposeAll();
  }
  try {
    fs.unlinkSync(role.paths.socket);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(role.paths.pid);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// Log uncaught exceptions and exit — a broken daemon should restart rather
// than spin at 100% CPU. The guard prevents recursive exceptions (e.g. if
// err.stack itself throws) from causing an infinite exception loop.
let handlingUncaught = false;

function installDaemonSignalHandlers(onShutdown: () => void): void {
  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);

  // The daemon is detached and outlives whoever started it. If its stdio
  // ends up on a pipe that later closes, a write must not surface as an
  // uncaughtException — that would shut down every session.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  process.on("uncaughtException", (err) => {
    if (handlingUncaught) {
      process.stderr.write(
        "[terminal-host] recursive uncaughtException — exiting\n",
      );
      process.exit(1);
    }
    handlingUncaught = true;
    try {
      log(`Uncaught exception: ${err?.message ?? err}\n${err?.stack ?? ""}`);
    } catch {
      process.stderr.write("[terminal-host] uncaughtException handler threw\n");
    }
    // Clean up and exit so the client can spawn a fresh daemon
    onShutdown();
  });
}

// ── Entry point ──
//
// `manor-host` (this same compiled bundle) plays three roles depending on
// argv:
//   - `--version` reports the version the bootstrap step (ADR-160 ticket 6)
//     compares against `app.getVersion()`.
//   - `remote-bridge` is the far end of an ssh stdio bridge: it never opens
//     the socket server itself, it only makes sure a daemon is running on
//     this box — in the `remote` namespace (~/.manor/remote/), never Manor
//     desktop's ~/.manor/daemon/ — and pumps stdin/stdout against that
//     daemon's control socket. Signal handlers that tear down *this* box's
//     daemon would be wrong here, since this process did not spawn it — see
//     `bridge.ts`.
//   - `restart` stops this box's remote-namespace daemon and clears its
//     socket and pid file (Manor desktop's daemon, if any, is left alone),
//     using the same path logic as a local client (`LocalTransport.stop`).
//     The next `remote-bridge` spawns the replacement. `SshTransport.restart`
//     runs this over ssh when the handshake reports a protocol mismatch.
//   - Anything else (the normal case: no argv) starts the daemon itself, as
//     `localRole` unless argv has `--namespace remote` (see daemon-role.ts).
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [mode] = argv;

  if (mode === "--version") {
    process.stdout.write(`${process.env.MANOR_VERSION ?? "unknown"}\n`);
    return;
  }

  if (mode === "remote-bridge") {
    await runRemoteBridgeProcess(new LocalTransport({ namespace: "remote" }));
    return;
  }

  if (mode === "restart") {
    await new LocalTransport({ namespace: "remote" }).stop();
    return;
  }

  // `LocalTransport` spawns a remote-namespace daemon with `--namespace remote`.
  const nsIndex = argv.indexOf("--namespace");
  const role =
    nsIndex >= 0 && argv[nsIndex + 1] === "remote" ? remoteRole(log) : localRole();

  let server: DaemonServer | null = null;
  installDaemonSignalHandlers(() => shutdown(role, server));
  server = startServer(role);
}

void main();
