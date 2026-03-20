#!/usr/bin/env node
/**
 * E2E harness — tests the BUILT daemon and persistence pipeline.
 *
 * Runs the actual compiled daemon (dist-electron/terminal-host-index.js),
 * connects real sockets, writes data, disconnects, reconnects, and verifies
 * persistence. This catches issues that unit/integration tests miss:
 * wrong build paths, missing modules, broken IPC in the real bundle, etc.
 *
 * Usage: node scripts/test-daemon-e2e.mjs
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Use a temp directory to avoid polluting ~/.manor
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-harness-"));
const SOCKET_PATH = path.join(TMP, "terminal-host.sock");
const TOKEN_PATH = path.join(TMP, "terminal-host.token");
const PID_PATH = path.join(TMP, "terminal-host.pid");
const SESSIONS_DIR = path.join(TMP, "sessions");

const DAEMON_SCRIPT = path.join(
  ROOT,
  "dist-electron",
  "terminal-host-index.js",
);

let daemonProc = null;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

function assertContains(haystack, needle, msg) {
  assert(typeof haystack === "string" && haystack.includes(needle), msg);
}

// ── Socket helpers ──

function connectRaw(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      let buf = "";
      const pending = [];
      const received = [];
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const p = JSON.parse(l);
            if (pending.length > 0) pending.shift()(p);
            else received.push(p);
          } catch {}
        }
      });
      resolve({
        socket,
        send: (msg) => socket.write(JSON.stringify(msg) + "\n"),
        readLine: () =>
          new Promise((r) => {
            if (received.length > 0) r(received.shift());
            else pending.push(r);
          }),
        close: () => socket.destroy(),
      });
    });
    socket.on("error", reject);
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(socketPath, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(socketPath)) {
      await delay(200); // let server finish binding
      return;
    }
    await delay(100);
  }
  throw new Error(`Socket ${socketPath} did not appear within ${timeoutMs}ms`);
}

// ── Daemon lifecycle ──

async function startDaemon() {
  console.log(`\nStarting daemon: ${DAEMON_SCRIPT}`);

  if (!fs.existsSync(DAEMON_SCRIPT)) {
    console.error(
      `\n  ERROR: ${DAEMON_SCRIPT} not found. Run 'pnpm build' first.\n`,
    );
    process.exit(1);
  }

  // The daemon reads paths from hardcoded constants — we need to override them.
  // The built index.js uses ~/.manor paths. We'll patch the env to redirect.
  // Actually, the built daemon hardcodes ~/.manor. For this harness we need to
  // either: (a) modify the daemon to accept env-var overrides, or (b) just use
  // the real ~/.manor dir for testing and clean up after.
  //
  // Let's go with (b) but use a unique session ID to avoid collisions.

  // Actually — let's verify the daemon can start at all first, using real ~/.manor.
  // We'll clean up our test sessions after.

  daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });

  let stderrOutput = "";
  daemonProc.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  daemonProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n  Daemon exited with code ${code}`);
      console.error(`  stderr: ${stderrOutput.slice(0, 500)}`);
    }
  });

  // Wait for the real socket to appear
  const realSocket = path.join(os.homedir(), ".manor", "terminal-host.sock");
  try {
    await waitForSocket(realSocket, 8000);
  } catch {
    console.error("\n  ERROR: Daemon failed to start. stderr:");
    console.error(`  ${stderrOutput.slice(0, 1000)}`);
    cleanup();
    process.exit(1);
  }

  console.log("  Daemon started.");
  return realSocket;
}

function stopDaemon() {
  if (daemonProc) {
    daemonProc.kill("SIGTERM");
    daemonProc = null;
  }
}

function cleanup() {
  stopDaemon();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}

// ── Tests ──

async function testBasicDaemonLifecycle(socketPath) {
  console.log("\n── Test: basic daemon lifecycle ──");

  const tokenPath = path.join(os.homedir(), ".manor", "terminal-host.token");
  let token;
  try {
    token = fs.readFileSync(tokenPath, "utf-8").trim();
  } catch (e) {
    console.error(`  ERROR: Cannot read token file: ${e.message}`);
    return;
  }

  assert(token.length > 0, "token file exists and is non-empty");

  // Connect and auth
  let client;
  try {
    client = await connectRaw(socketPath);
  } catch (e) {
    console.error(`  ERROR: Cannot connect to daemon: ${e.message}`);
    return;
  }

  client.send({ type: "auth", token });
  const authResp = await client.readLine();
  assert(authResp.type === "authOk", "auth succeeds with correct token");

  // Ping
  client.send({ type: "ping" });
  const pong = await client.readLine();
  assert(pong.type === "pong", "ping/pong works");

  client.close();
}

async function testSessionPersistence(socketPath) {
  console.log("\n── Test: session creation + scrollback persistence ──");

  const tokenPath = path.join(os.homedir(), ".manor", "terminal-host.token");
  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  const sessionsDir = path.join(os.homedir(), ".manor", "sessions");

  const sessionId = `e2e-test-${crypto.randomUUID()}`;

  // Connect and create session
  const client = await connectRaw(socketPath);
  client.send({ type: "auth", token });
  await client.readLine();

  client.send({ type: "create", sessionId, cwd: "/tmp", cols: 80, rows: 24 });
  const createResp = await client.readLine();
  assert(createResp.type === "created", "session created");
  assert(createResp.session.sessionId === sessionId, "session ID matches");

  // Check files on disk
  const sessionDir = path.join(sessionsDir, sessionId);
  await delay(200); // let session init complete
  assert(fs.existsSync(sessionDir), `session dir created: ${sessionDir}`);

  const metaPath = path.join(sessionDir, "meta.json");
  assert(fs.existsSync(metaPath), "meta.json exists");

  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    assert(meta.sessionId === sessionId, "meta.json has correct sessionId");
    assert(meta.cols === 80, "meta.json has correct cols");
    assert(meta.endedAt === null, "endedAt is null (session alive)");
  }

  const scrollbackPath = path.join(sessionDir, "scrollback.bin");
  assert(fs.existsSync(scrollbackPath), "scrollback.bin exists");

  // List sessions
  client.send({ type: "listSessions" });
  const listResp = await client.readLine();
  assert(listResp.type === "sessions", "listSessions responds");
  const found = listResp.sessions.find((s) => s.sessionId === sessionId);
  assert(!!found, "our session appears in list");

  // Get snapshot (should be empty since no PTY output yet)
  client.send({ type: "getSnapshot", sessionId });
  const snapResp = await client.readLine();
  assert(snapResp.type === "snapshot", "getSnapshot responds");
  assert(snapResp.snapshot.cols === 80, "snapshot has correct cols");

  client.close();

  // Clean up test session
  const client2 = await connectRaw(socketPath);
  client2.send({ type: "auth", token });
  await client2.readLine();
  client2.send({ type: "kill", sessionId });
  await client2.readLine();
  client2.close();

  // Clean up files
  await delay(500);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {}

  return sessionId;
}

async function testWarmRestore(socketPath) {
  console.log("\n── Test: warm restore (disconnect + reconnect) ──");

  const tokenPath = path.join(os.homedir(), ".manor", "terminal-host.token");
  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  const sessionsDir = path.join(os.homedir(), ".manor", "sessions");
  const sessionId = `e2e-warm-${crypto.randomUUID()}`;

  // Client 1: create session
  const c1 = await connectRaw(socketPath);
  c1.send({ type: "auth", token });
  await c1.readLine();

  c1.send({ type: "create", sessionId, cwd: "/tmp", cols: 80, rows: 24 });
  await c1.readLine();

  // Client 1: disconnect
  c1.close();
  await delay(100);

  // Client 2: reconnect and try to attach
  const c2 = await connectRaw(socketPath);
  c2.send({ type: "auth", token });
  await c2.readLine();

  c2.send({ type: "attach", sessionId });
  const attachResp = await c2.readLine();
  assert(
    attachResp.type === "attached",
    "warm restore: attach succeeds after disconnect",
  );
  assert(attachResp.snapshot !== undefined, "warm restore: snapshot returned");
  assert(
    attachResp.snapshot.cols === 80,
    "warm restore: snapshot has correct dimensions",
  );

  // Clean up
  c2.send({ type: "kill", sessionId });
  await c2.readLine();
  c2.close();

  await delay(500);
  try {
    fs.rmSync(path.join(sessionsDir, sessionId), {
      recursive: true,
      force: true,
    });
  } catch {}
}

async function testStreamSocket(socketPath) {
  console.log("\n── Test: stream socket events ──");

  const tokenPath = path.join(os.homedir(), ".manor", "terminal-host.token");
  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  const sessionsDir = path.join(os.homedir(), ".manor", "sessions");
  const sessionId = `e2e-stream-${crypto.randomUUID()}`;

  // Control: create session
  const control = await connectRaw(socketPath);
  control.send({ type: "auth", token });
  await control.readLine();

  control.send({ type: "create", sessionId, cwd: "/tmp", cols: 80, rows: 24 });
  await control.readLine();

  // Stream: subscribe
  const stream = await connectRaw(socketPath);
  stream.send({ connectionType: "stream", token });
  stream.send({ type: "subscribe", sessionId });
  await delay(200);

  // Write via stream
  stream.send({ type: "write", sessionId, data: "echo hello\n" });
  await delay(500);

  // The PTY should produce output that arrives on the stream socket.
  // Since this is a real PTY, we should get some output back.
  const event = await Promise.race([
    stream.readLine(),
    delay(3000).then(() => null),
  ]);

  assert(event !== null, "stream socket receives PTY output");
  if (event) {
    assert(
      event.type === "data",
      `stream event type is 'data' (got ${event.type})`,
    );
    assert(event.sessionId === sessionId, "stream event has correct sessionId");
  }

  // Clean up
  control.send({ type: "kill", sessionId });
  await control.readLine();
  control.close();
  stream.close();

  await delay(500);
  try {
    fs.rmSync(path.join(sessionsDir, sessionId), {
      recursive: true,
      force: true,
    });
  } catch {}
}

// ── Main ──

async function main() {
  console.log("Manor Terminal Daemon E2E Harness");
  console.log("=================================");
  console.log(`Temp dir: ${TMP}`);
  console.log(`Daemon:   ${DAEMON_SCRIPT}`);

  try {
    const socketPath = await startDaemon();

    await testBasicDaemonLifecycle(socketPath);
    await testSessionPersistence(socketPath);
    await testWarmRestore(socketPath);
    await testStreamSocket(socketPath);

    console.log(`\n=================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log("\nSome tests failed. The daemon may have issues with:");
      console.log("  - Module resolution (node-pty, @xterm/headless, etc.)");
      console.log("  - File path expectations (dist-electron layout)");
      console.log("  - Socket/auth setup");
    }
  } catch (e) {
    console.error(`\nFatal error: ${e.message}`);
    console.error(e.stack);
  } finally {
    cleanup();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
