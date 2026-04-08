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
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { TerminalHost } from "./terminal-host";
import type { ControlRequest, ControlResponse, StreamCommand } from "./types";

const MANOR_DIR = path.join(os.homedir(), ".manor");
const version = process.env.MANOR_VERSION || "unknown";
const DAEMON_DIR = path.join(MANOR_DIR, "daemons", version);
const SOCKET_PATH = path.join(DAEMON_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(DAEMON_DIR, "terminal-host.token");
const PID_PATH = path.join(DAEMON_DIR, "terminal-host.pid");

const daemonVersion = process.env.MANOR_VERSION;

const host = new TerminalHost();
const authenticatedSockets = new WeakSet<net.Socket>();

// Map of stream sockets that are subscribed to sessions
const streamSockets = new Set<net.Socket>();

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
    sendResponse(socket, { type: "error", message: "Not authenticated" }, requestId);
    return;
  }

  switch (request.type) {
    case "auth": {
      const expected = readToken();
      if (request.token === expected) {
        authenticatedSockets.add(socket);
        sendResponse(socket, { type: "authOk", version: daemonVersion }, requestId);
      } else {
        sendResponse(socket, { type: "error", message: "Invalid token" }, requestId);
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
        );
        sendResponse(socket, { type: "created", session }, requestId);
      } catch (err) {
        log(`Failed to create session ${request.sessionId}: ${err}`);
        sendResponse(socket, {
          type: "error",
          message: `Create failed: ${err instanceof Error ? err.message : String(err)}`,
        }, requestId);
      }
      break;
    }

    case "attach": {
      const snapshot = await host.attach(request.sessionId, socket);
      if (snapshot) {
        sendResponse(socket, { type: "attached", snapshot }, requestId);
      } else {
        sendResponse(socket, {
          type: "error",
          message: `Session ${request.sessionId} not found`,
        }, requestId);
      }
      break;
    }

    case "detach": {
      host.detach(request.sessionId, socket);
      sendResponse(socket, { type: "detached" }, requestId);
      break;
    }

    case "resize": {
      host.resize(request.sessionId, request.cols, request.rows);
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
        sendResponse(socket, { type: "error", message: `Session ${request.sessionId} not found` }, requestId);
      }
      break;
    }

    case "getSnapshot": {
      const snapshot = await host.getSnapshot(request.sessionId);
      if (snapshot) {
        host.clearPrewarmed(request.sessionId);
        sendResponse(socket, { type: "snapshot", snapshot }, requestId);
      } else {
        sendResponse(socket, {
          type: "error",
          message: `Session ${request.sessionId} not found`,
        }, requestId);
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
    queue = queue.then(() => handler(request)).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse(socket, { type: "error", message: `Internal error: ${message}` }, requestId);
      log(`Error handling control message: ${message}`);
    });
  };
}

// ── Server ──

setup();

const server = net.createServer((socket) => {
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

// ── Graceful shutdown ──

function shutdown(): void {
  log("Shutting down...");
  host.disposeAll();
  server.close();
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

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Keep daemon alive
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`);
});
