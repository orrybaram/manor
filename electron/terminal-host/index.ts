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
import type {
  ControlRequest,
  ControlResponse,
  StreamCommand,
  StreamEvent,
} from "./types";
import * as path from "node:path";
import {
  daemonDir,
  daemonSocketFile,
  daemonTokenFile,
  daemonPidFile,
  hookJournalFile,
  remoteHookPortFile,
  type DaemonNamespace,
} from "../paths";
import { runRemoteBridgeProcess } from "./bridge";
import { LocalTransport } from "./transport-local";
import { ExecRunner, runExec } from "./exec-runner";
import { createSerializedHandler } from "./control-queue";
import { bootstrapHost } from "./bootstrap-host";
import { HookJournal } from "./hook-journal";
import { HookListener } from "./hook-listener";

/**
 * Which of this machine's daemons this process is (see `DaemonNamespace` in
 * electron/paths.ts): `local` for Manor desktop, `remote` when spawned by
 * `manor-host remote-bridge`. Set once in `main()` before `startServer()`;
 * every path below derives from it.
 */
let namespace: DaemonNamespace = "local";
let DAEMON_DIR = daemonDir(namespace);
let SOCKET_PATH = daemonSocketFile(namespace);
let TOKEN_PATH = daemonTokenFile(namespace);
let PID_PATH = daemonPidFile(namespace);

function setNamespace(ns: DaemonNamespace): void {
  namespace = ns;
  DAEMON_DIR = daemonDir(ns);
  SOCKET_PATH = daemonSocketFile(ns);
  TOKEN_PATH = daemonTokenFile(ns);
  PID_PATH = daemonPidFile(ns);
}

/** Env a remote daemon's hook listener owns; `updateEnv` never overrides it. */
const HOOK_ENV_KEYS = new Set(["MANOR_HOOK_PORT", "MANOR_HOOK_PORT_FILE"]);

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
    const created = new ExecRunner();
    // Streamed exec output is paused whenever the socket's write buffer is
    // full (see sendStreamEvent's return value) and resumed once it drains.
    socket.on("drain", () => created.resumeOutput());
    execRunners.set(socket, created);
    runner = created;
  }
  return runner;
}

// Per-control-socket aborters for in-flight `exec` requests, so a socket that
// closes mid-exec kills the command it started instead of leaving it running.
const inFlightExecs = new Map<net.Socket, Set<AbortController>>();

/**
 * Every authenticated stream socket, subscribed to a session or not —
 * `hookEvent`s go to all of them (ADR-178 §2).
 */
const hookStreamSockets = new Set<net.Socket>();

let hookJournal: HookJournal | null = null;
let hookListener: HookListener | null = null;

/** The hook journal, opened (and recovered) on first use. */
function getHookJournal(): HookJournal {
  if (!hookJournal) {
    const journal = new HookJournal(hookJournalFile(), { log });
    journal.open();
    hookJournal = journal;
  }
  return hookJournal;
}

/**
 * Remote mode (ADR-178 §2): a daemon in the `remote` namespace serves
 * clients on another machine, so it owns the host's agent hooks — a
 * loopback listener published in the remote namespace's own port file
 * (`remoteHookPortFile()`, which every PTY spawned from here on gets as
 * `MANOR_HOOK_PORT_FILE`), journaling what it receives for replay.
 *
 * Started at daemon startup, so a daemon restarted on the box (after a crash
 * or a reboot) journals before any client reconnects; `bootstrap` just
 * reports the port. A `local` daemon — Manor desktop's — never listens: its
 * hooks go to the desktop's own `AgentHookServer` via ~/.manor/hook-port.
 */
async function enableRemoteMode(): Promise<number> {
  if (namespace !== "remote") {
    throw new Error("only a remote-namespace daemon journals agent hooks");
  }
  if (!hookListener) {
    hookListener = new HookListener({
      journal: getHookJournal(),
      portFile: remoteHookPortFile(),
      log,
      onEntry: (entry) => {
        const event: StreamEvent = {
          type: "hookEvent",
          seq: entry.seq,
          payload: entry.payload,
        };
        for (const socket of hookStreamSockets) sendStreamEvent(socket, event);
      },
    });
  }
  const port = await hookListener.start();
  log(`hook listener on 127.0.0.1:${port} (journal seq ${getHookJournal().lastSeq})`);
  return port;
}

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

// ── Setup ──

function setup(): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });

  if (namespace === "local") {
    // Before the remote namespace existed, a remote-bridge daemon shared this
    // directory and left a flag here that turned hook journaling on. A local
    // daemon never journals, so the flag is only ever stale.
    try {
      fs.unlinkSync(path.join(DAEMON_DIR, "remote-mode"));
    } catch {
      // Not there — the normal case.
    }
  }

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
        // In remote mode the hook endpoint is this daemon's own listener; a
        // client's value names a port on *its* machine (ADR-178 §2).
        if (namespace === "remote" && HOOK_ENV_KEYS.has(key)) continue;
        process.env[key] = value;
      }
      sendResponse(socket, { type: "envUpdated" }, requestId);
      break;
    }

    // exec and readFile are dispatched outside the serial queue (see
    // control-queue.ts) — their responses may go out after later requests'.
    case "exec": {
      log(`exec: ${request.cmd}`);
      const aborter = new AbortController();
      let execs = inFlightExecs.get(socket);
      if (!execs) {
        execs = new Set();
        inFlightExecs.set(socket, execs);
      }
      execs.add(aborter);
      let result;
      try {
        result = await runExec(request.cmd, request.args, {
          cwd: request.cwd,
          timeout: request.timeout,
          maxBuffer: request.maxBuffer,
          signal: aborter.signal,
        });
      } finally {
        execs.delete(aborter);
      }
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
        const { size } = await fsStat(request.path);
        if (size > MAX_READ_FILE_BYTES) {
          throw new Error(
            `file is ${size} bytes, over the ${MAX_READ_FILE_BYTES}-byte limit`,
          );
        }
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

    case "bootstrap": {
      // Set this host up for Manor shells and agent hooks, against the
      // daemon's own filesystem. MCP registration is skipped: the MCP webview
      // server talks to Electron's webview server, which is not on this host.
      try {
        const { agents, warnings } = bootstrapHost({ mcpServerScriptPath: null });
        log(`bootstrap: registered agents ${agents.join(", ")}`);
        let hookPort: number | undefined;
        try {
          hookPort = await enableRemoteMode();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`agent hook listener could not start: ${message}`);
        }
        if (warnings.length > 0) {
          for (const warning of warnings) log(`bootstrap warning: ${warning}`);
        }
        sendResponse(
          socket,
          {
            type: "bootstrapped",
            agents,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(hookPort !== undefined ? { hookPort } : {}),
          },
          requestId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`bootstrap failed: ${message}`);
        sendResponse(
          socket,
          { type: "error", message },
          requestId,
        );
      }
      break;
    }

    case "replayHooks": {
      if (namespace !== "remote") {
        // Manor desktop's daemon has no journal; answer as a daemon that
        // predates `replayHooks` would, which callers read as "no journal".
        sendResponse(
          socket,
          { type: "error", message: "unknown request type: replayHooks" },
          requestId,
        );
        break;
      }
      const journal = getHookJournal();
      sendResponse(
        socket,
        {
          type: "hookReplay",
          entries: request.headOnly
            ? []
            : journal.since(Number(request.sinceSeq) || 0),
          lastSeq: journal.lastSeq,
          epoch: journal.epoch,
        },
        requestId,
      );
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

    default: {
      // A newer client asking for something this daemon does not know. Answer
      // rather than stay silent, or the client waits out its timeout and then
      // drops the whole connection.
      const unknownType = (request as { type?: unknown }).type;
      sendResponse(
        socket,
        {
          type: "error",
          message: `unknown request type: ${String(unknownType)}`,
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
      execRunners.get(socket)?.cancel(command.execId);
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

function createControlHandler(socket: net.Socket): (line: string) => void {
  return createSerializedHandler(
    (req) => handleControlMessage(socket, req),
    (requestId, err) => {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse(
        socket,
        { type: "error", message: `Internal error: ${message}` },
        requestId,
      );
      log(`Error handling control message: ${message}`);
    },
    () => sendResponse(socket, { type: "error", message: "Invalid JSON" }),
  );
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
              hookStreamSockets.add(socket);
            }
          }
        } else {
          connectionType = "control";
          lineHandler = createControlHandler(socket);
          // Process this line as a control message (could be auth)
          lineHandler(line);
        }
      } catch {
        // Default to control
        connectionType = "control";
        lineHandler = createControlHandler(socket);
        lineHandler(line);
      }
    });

    socket.on("data", initialParser);

    socket.on("close", () => {
      log("Client disconnected");
      host.detachAllFromSocket(socket);
      streamSockets.delete(socket);
      hookStreamSockets.delete(socket);
      // Kill any live execStream children so a dropped connection (e.g. a
      // dropped ssh session) cannot leak processes.
      execRunners.get(socket)?.disposeAll();
      execRunners.delete(socket);
      // Likewise for request/response execs still running for this socket.
      for (const aborter of inFlightExecs.get(socket) ?? []) aborter.abort();
      inFlightExecs.delete(socket);
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

  if (namespace === "remote") {
    enableRemoteMode().catch((err: unknown) => {
      log(`hook listener failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// ── Graceful shutdown ──

function shutdown(): void {
  log("Shutting down...");
  hookListener?.stop();
  hookJournal?.compact();
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
//     running on this box — in the `remote` namespace (~/.manor/remote/),
//     never Manor desktop's ~/.manor/daemon/ — and pumps stdin/stdout
//     against that daemon's control socket. Signal handlers that tear down *this* box's daemon
//     would be wrong here, since this process did not spawn it — see
//     `bridge.ts`.
//   - `restart` stops this box's remote-namespace daemon and clears its
//     socket and pid file (Manor desktop's daemon, if any, is left alone),
//     using the same path logic as a local client (`LocalTransport.stop`).
//     The next `remote-bridge` spawns the replacement. `SshTransport.restart`
//     runs this over ssh when the handshake reports a version mismatch.
//   - Anything else (the normal case: no argv) starts the daemon itself, in
//     the `local` namespace unless argv has `--namespace remote`.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [mode, ...rest] = argv;

  if (mode === "--version") {
    process.stdout.write(`${process.env.MANOR_VERSION ?? "unknown"}\n`);
    return;
  }

  if (mode === "remote-bridge") {
    if (rest.includes("--stream")) {
      // Informational only — control and stream share one socket path today.
      process.stderr.write("[terminal-host] remote-bridge: stream mode\n");
    }
    await runRemoteBridgeProcess(new LocalTransport({ namespace: "remote" }));
    return;
  }

  if (mode === "restart") {
    await new LocalTransport({ namespace: "remote" }).stop();
    return;
  }

  // `LocalTransport` spawns a remote-namespace daemon with `--namespace remote`.
  const nsIndex = argv.indexOf("--namespace");
  if (nsIndex >= 0 && argv[nsIndex + 1] === "remote") setNamespace("remote");

  installDaemonSignalHandlers();
  startServer();
}

void main();
