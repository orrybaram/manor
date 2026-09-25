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
import { readFile as fsReadFile } from "node:fs/promises";
import { TerminalHost } from "./terminal-host";
import { TERMINAL_HOST_PROTOCOL } from "./types";
import type {
  ControlRequest,
  ControlResponse,
  StreamCommand,
  StreamEvent,
} from "./types";
import {
  daemonDir,
  daemonSocketFile,
  daemonTokenFile,
  daemonPidFile,
} from "../paths";
import { runRemoteBridge } from "./bridge";
import { LocalTransport } from "./transport-local";
import { ExecRunner, runExec } from "./exec-runner";

const DAEMON_DIR = daemonDir();
const SOCKET_PATH = daemonSocketFile();
const TOKEN_PATH = daemonTokenFile();
const PID_PATH = daemonPidFile();

const daemonVersion = process.env.MANOR_VERSION;

const host = new TerminalHost();
const authenticatedSockets = new WeakSet<net.Socket>();

// Map of stream sockets that are subscribed to sessions
const streamSockets = new Set<net.Socket>();

// Per-stream-socket execId → child bookkeeping for execStream/execCancel.
// Keyed by socket so a dropped connection kills exactly its own children.
const execRunners = new Map<net.Socket, ExecRunner>();

function getExecRunner(socket: net.Socket): ExecRunner {
  let runner = execRunners.get(socket);
  if (!runner) {
    runner = new ExecRunner();
    execRunners.set(socket, runner);
  }
  return runner;
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[terminal-host ${ts}] ${msg}\n`);
}

// ── Setup ──

function setup(): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });

  // Generate auth token
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });

  // Write PID file
  fs.writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });

  // Clean up stale socket
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // doesn't exist
  }
}

function readToken(): string {
  return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
}

// ── Control socket handling ──

async function handleControlMessage(
  socket: net.Socket,
  request: ControlRequest & { requestId?: string },
): Promise<void> {
  const requestId = request.requestId;

  // Auth check (except for auth request itself)
  if (request.type !== "auth" && !authenticatedSockets.has(socket)) {
    sendResponse(
      socket,
      { type: "error", message: "Not authenticated" },
      requestId,
    );
    return;
  }

  switch (request.type) {
    case "auth": {
      const expected = readToken();
      if (request.token === expected) {
        authenticatedSockets.add(socket);
        sendResponse(
          socket,
          { type: "authOk", version: daemonVersion },
          requestId,
        );
      } else {
        sendResponse(
          socket,
          { type: "error", message: "Invalid token" },
          requestId,
        );
      }
      break;
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
        sendResponse(socket, { type: "created", session }, requestId);
      } catch (err) {
        log(`Failed to create session ${request.sessionId}: ${err}`);
        sendResponse(
          socket,
          {
            type: "error",
            message: `Create failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          requestId,
        );
      }
      break;
    }

    case "attach": {
      const snapshot = await host.attach(request.sessionId, socket);
      if (snapshot) {
        sendResponse(socket, { type: "attached", snapshot }, requestId);
      } else {
        sendResponse(
          socket,
          { type: "notFound", sessionId: request.sessionId },
          requestId,
        );
      }
      break;
    }

    case "detach": {
      host.detach(request.sessionId, socket);
      sendResponse(socket, { type: "detached" }, requestId);
      break;
    }

    case "resize": {
      await host.resize(request.sessionId, request.cols, request.rows);
      sendResponse(socket, { type: "resized" }, requestId);
      break;
    }

    case "kill": {
      await host.kill(request.sessionId);
      sendResponse(socket, { type: "killed" }, requestId);
      break;
    }

    case "writeAfterReady": {
      const ok = host.writeAfterReady(request.sessionId, request.data);
      if (ok) {
        sendResponse(socket, { type: "writeQueued" }, requestId);
      } else {
        sendResponse(
          socket,
          { type: "error", message: `Session ${request.sessionId} not found` },
          requestId,
        );
      }
      break;
    }

    case "getSnapshot": {
      const snapshot = await host.getSnapshot(request.sessionId);
      if (snapshot) {
        host.clearPrewarmed(request.sessionId);
        sendResponse(socket, { type: "snapshot", snapshot }, requestId);
      } else {
        // A fact, not a failure — the caller decides whether to spawn a shell.
        sendResponse(
          socket,
          { type: "notFound", sessionId: request.sessionId },
          requestId,
        );
      }
      break;
    }

    case "disposeDead": {
      host.disposeDeadSessions();
      sendResponse(socket, { type: "disposedDead" }, requestId);
      break;
    }

    case "listSessions": {
      const sessions = host.listSessions();
      sendResponse(socket, { type: "sessions", sessions }, requestId);
      break;
    }

    case "ping": {
      sendResponse(socket, { type: "pong" }, requestId);
      break;
    }

    case "updateEnv": {
      // Update daemon process.env so new PTY sessions inherit fresh values.
      // This is needed when the Electron app restarts (new hook port, etc.)
      // but reconnects to an existing daemon.
      for (const [key, value] of Object.entries(request.env)) {
        process.env[key] = value;
      }
      sendResponse(socket, { type: "envUpdated" }, requestId);
      break;
    }

    case "exec": {
      log(`exec: ${request.cmd}`);
      const result = await runExec(request.cmd, request.args, {
        cwd: request.cwd,
        timeout: request.timeout,
        maxBuffer: request.maxBuffer,
      });
      sendResponse(
        socket,
        {
          type: "execResult",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        requestId,
      );
      break;
    }

    case "readFile": {
      try {
        const contents = await fsReadFile(request.path, "utf-8");
        sendResponse(socket, { type: "fileContents", contents }, requestId);
      } catch (err) {
        sendResponse(
          socket,
          {
            type: "error",
            message: `readFile failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          requestId,
        );
      }
      break;
    }

    case "handshake": {
      // Client sends its app version; daemon replies with its own.
      // Version mismatch causes the client to kill and respawn the daemon.
      sendResponse(
        socket,
        {
          type: "handshake",
          daemonVersion: daemonVersion ?? "unknown",
          protocol: TERMINAL_HOST_PROTOCOL,
        },
        requestId,
      );
      break;
    }
  }
}

async function handleStreamMessage(
  socket: net.Socket,
  line: string,
): Promise<void> {
  let command: StreamCommand;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  if (!authenticatedSockets.has(socket)) return;

  switch (command.type) {
    case "write":
      host.write(command.sessionId, command.data);
      break;
    case "subscribe":
      await host.attach(command.sessionId, socket);
      streamSockets.add(socket);
      break;
    case "unsubscribe":
      host.detach(command.sessionId, socket);
      break;
    case "agentHook":
      log(
        `[agent-status] relay: session=${command.sessionId} status=${command.status} kind=${command.kind}`,
      );
      host.setAgentHookStatus(command.sessionId, command.status, command.kind);
      break;
    case "execStream": {
      log(`execStream: ${command.cmd}`);
      const runner = getExecRunner(socket);
      runner.start(
        command.execId,
        command.cmd,
        command.args,
        { cwd: command.cwd },
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
      execRunners.get(socket)?.cancel(command.execId);
      break;
  }
}

function sendStreamEvent(socket: net.Socket, event: StreamEvent): void {
  try {
    socket.write(JSON.stringify(event) + "\n");
  } catch {
    // socket may be closed
  }
}

function sendResponse(
  socket: net.Socket,
  response: ControlResponse,
  requestId?: string,
): void {
  try {
    const payload = requestId ? { ...response, requestId } : response;
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

/**
 * Serialize async handler calls to maintain request/response ordering.
 * Without this, an async handler (e.g. getSnapshot awaiting flushHeadless)
 * can yield, letting a later request complete first and sending responses
 * out of order — which corrupts the client's FIFO response queue.
 */
function createSerializedHandler(
  socket: net.Socket,
  handler: (request: ControlRequest & { requestId?: string }) => Promise<void>,
): (line: string) => void {
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    let request: ControlRequest & { requestId?: string };
    try {
      request = JSON.parse(line);
    } catch {
      sendResponse(socket, { type: "error", message: "Invalid JSON" });
      return;
    }
    const requestId = request.requestId;
    queue = queue
      .then(() => handler(request))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse(
          socket,
          { type: "error", message: `Internal error: ${message}` },
          requestId,
        );
        log(`Error handling control message: ${message}`);
      });
  };
}

// ── Server ──

let server: net.Server | null = null;

function startServer(): void {
  setup();

  server = net.createServer((socket) => {
    log("Client connected");

    // First line determines connection type: {"connectionType":"control"} or {"connectionType":"stream"}
    let connectionType: "control" | "stream" | null = null;
    let lineHandler: ((line: string) => void) | null = null;

    const initialParser = createLineParser((line) => {
      if (connectionType !== null) {
        lineHandler?.(line);
        return;
      }

      try {
        const msg = JSON.parse(line);
        if (msg.connectionType === "stream") {
          connectionType = "stream";
          lineHandler = (l) => handleStreamMessage(socket, l);
          // Re-authenticate stream sockets using the auth in the init message
          if (msg.token) {
            const expected = readToken();
            if (msg.token === expected) {
              authenticatedSockets.add(socket);
            }
          }
        } else {
          connectionType = "control";
          lineHandler = createSerializedHandler(socket, (req) =>
            handleControlMessage(socket, req),
          );
          // Process this line as a control message (could be auth)
          lineHandler(line);
        }
      } catch {
        // Default to control
        connectionType = "control";
        lineHandler = createSerializedHandler(socket, (l) =>
          handleControlMessage(socket, l),
        );
        lineHandler(line);
      }
    });

    socket.on("data", initialParser);

    socket.on("close", () => {
      log("Client disconnected");
      host.detachAllFromSocket(socket);
      streamSockets.delete(socket);
      // Kill any live execStream children so a dropped connection (e.g. a
      // dropped ssh session) cannot leak processes.
      execRunners.get(socket)?.disposeAll();
      execRunners.delete(socket);
    });

    socket.on("error", (err) => {
      log(`Socket error: ${err.message}`);
    });
  });

  server.listen(SOCKET_PATH, () => {
    log(`Listening on ${SOCKET_PATH}`);
    // Make socket accessible
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {
      // ignore
    }
  });
}

// ── Graceful shutdown ──

function shutdown(): void {
  log("Shutting down...");
  host.disposeAll();
  server?.close();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// Log uncaught exceptions and exit — a broken daemon should restart rather
// than spin at 100% CPU. The guard prevents recursive exceptions (e.g. if
// err.stack itself throws) from causing an infinite exception loop.
let handlingUncaught = false;

function installDaemonSignalHandlers(): void {
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

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
    shutdown();
  });
}

// ── Entry point ──
//
// `manor-host` (this same compiled bundle) plays three roles depending on
// argv:
//   - `--version` reports the version the bootstrap step (ADR-160 ticket 6)
//     compares against `app.getVersion()`.
//   - `remote-bridge [--stream]` is the far end of an ssh stdio bridge: it
//     never opens the socket server itself, it only makes sure a daemon is
//     running on this box and pumps stdin/stdout against that daemon's
//     control socket. Signal handlers that tear down *this* box's daemon
//     would be wrong here, since this process did not spawn it — see
//     `bridge.ts`.
//   - `restart` stops this box's daemon and clears its socket and pid file,
//     using the same path logic as a local client (`LocalTransport.stop`).
//     The next `remote-bridge` spawns the replacement. `SshTransport.restart`
//     runs this over ssh when the handshake reports a version mismatch.
//   - Anything else (the normal case: no argv) starts the daemon itself.
async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "--version") {
    process.stdout.write(`${process.env.MANOR_VERSION ?? "unknown"}\n`);
    return;
  }

  if (mode === "remote-bridge") {
    if (rest.includes("--stream")) {
      // Informational only — control and stream share one socket path today.
      process.stderr.write("[terminal-host] remote-bridge: stream mode\n");
    }
    process.exitCode = await runRemoteBridge();
    return;
  }

  if (mode === "restart") {
    await new LocalTransport().stop();
    return;
  }

  installDaemonSignalHandlers();
  startServer();
}

void main();
