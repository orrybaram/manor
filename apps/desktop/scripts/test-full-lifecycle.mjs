#!/usr/bin/env node
/**
 * Full lifecycle harness — simulates what the actual Electron app does:
 *
 * 1. Start daemon
 * 2. "App session 1": create sessions, type in them, verify output flows
 * 3. Save layout to disk (like app-store does)
 * 4. Disconnect (simulate app quit)
 * 5. Verify daemon is still alive
 * 6. "App session 2": load layout, reconnect using old pane IDs, verify warm restore
 * 7. Kill daemon, verify cold restore data on disk
 *
 * This catches the real integration bugs between layout persistence,
 * daemon session management, and the restore flow.
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
const DAEMON_SCRIPT = path.join(
  ROOT,
  "dist-electron",
  "terminal-host-index.js",
);
const MANOR_DIR = path.join(os.homedir(), ".manor");
const SOCKET_PATH = path.join(MANOR_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(MANOR_DIR, "terminal-host.token");
const PID_PATH = path.join(MANOR_DIR, "terminal-host.pid");
const LAYOUT_FILE = path.join(MANOR_DIR, "layout.json");
const SESSIONS_DIR = path.join(MANOR_DIR, "sessions");

let daemonProc = null;
let passed = 0;
let failed = 0;
const errors = [];

function log(msg) {
  console.log(msg);
}

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
    errors.push(msg);
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(
      `  ✗ ${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`,
    );
    errors.push(
      `${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`,
    );
  }
}

function assertContains(haystack, needle, msg) {
  if (typeof haystack === "string" && haystack.includes(needle)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    const preview =
      typeof haystack === "string" ? haystack.slice(0, 200) : String(haystack);
    console.log(
      `  ✗ ${msg} (string does not contain "${needle}", got: "${preview}...")`,
    );
    errors.push(msg);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Socket helpers ──

function connectRaw(socketPath) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("connect timeout")),
      5000,
    );
    const socket = net.createConnection(socketPath, () => {
      clearTimeout(timeout);
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
        readLine: (timeoutMs = 5000) =>
          new Promise((res, rej) => {
            if (received.length > 0) {
              res(received.shift());
              return;
            }
            const t = setTimeout(
              () => rej(new Error("readLine timeout")),
              timeoutMs,
            );
            pending.push((v) => {
              clearTimeout(t);
              res(v);
            });
          }),
        close: () => socket.destroy(),
      });
    });
    socket.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

/** Authenticated control socket helper */
async function connectControl(socketPath) {
  const token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  const c = await connectRaw(socketPath);
  c.send({ type: "auth", token });
  const resp = await c.readLine();
  if (resp.type !== "authOk")
    throw new Error(`Auth failed: ${JSON.stringify(resp)}`);
  return c;
}

/** Authenticated stream socket helper */
async function connectStream(socketPath) {
  const token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  const s = await connectRaw(socketPath);
  s.send({ connectionType: "stream", token });
  return s;
}

// ── Daemon lifecycle ──

async function ensureDaemonRunning() {
  // Check if already running
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, 0);
    if (fs.existsSync(SOCKET_PATH)) {
      log("  Daemon already running (pid " + pid + ")");
      return;
    }
  } catch {}

  log("  Spawning daemon...");
  daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  daemonProc.unref();

  let stderr = "";
  daemonProc.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (fs.existsSync(SOCKET_PATH)) {
      await delay(200);
      return;
    }
    await delay(100);
  }
  throw new Error("Daemon failed to start. stderr: " + stderr.slice(0, 500));
}

function killDaemon() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, "SIGKILL"); // hard kill to simulate crash
  } catch {}
  if (daemonProc) {
    try {
      daemonProc.kill("SIGKILL");
    } catch {}
    daemonProc = null;
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    fs.unlinkSync(PID_PATH);
  } catch {}
}

function cleanupTestSessions(paneIds) {
  for (const id of paneIds) {
    try {
      fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
    } catch {}
  }
}

// ── Tests ──

async function main() {
  log("Manor Full Lifecycle E2E");
  log("========================\n");

  if (!fs.existsSync(DAEMON_SCRIPT)) {
    log(`ERROR: ${DAEMON_SCRIPT} not found. Run 'pnpm build' first.`);
    process.exit(1);
  }

  // Use unique pane IDs for this test run
  const PANE_A = `e2e-pane-${crypto.randomUUID()}`;
  const PANE_B = `e2e-pane-${crypto.randomUUID()}`;
  const WORKSPACE_PATH = "/tmp/manor-e2e-test-workspace";

  try {
    // ── Phase 1: First "app session" ──
    log("Phase 1: First app session (create sessions, write data)");

    // Kill any leftover daemon
    killDaemon();
    await delay(500);

    await ensureDaemonRunning();
    assert(fs.existsSync(SOCKET_PATH), "daemon socket exists");
    assert(fs.existsSync(TOKEN_PATH), "daemon token exists");

    const ctrl1 = await connectControl(SOCKET_PATH);

    // Create two sessions (like the app would on startup)
    ctrl1.send({
      type: "create",
      sessionId: PANE_A,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    const createA = await ctrl1.readLine();
    assertEq(createA.type, "created", "session A created");

    ctrl1.send({
      type: "create",
      sessionId: PANE_B,
      cwd: "/tmp",
      cols: 120,
      rows: 40,
    });
    const createB = await ctrl1.readLine();
    assertEq(createB.type, "created", "session B created");

    // Subscribe to stream (separate socket — don't attach on control)
    const stream1 = await connectStream(SOCKET_PATH);
    stream1.send({ type: "subscribe", sessionId: PANE_A });
    stream1.send({ type: "subscribe", sessionId: PANE_B });

    // Wait for shell to start (prompt output, etc.)
    await delay(1500);

    // Drain any shell startup output
    let startupEvents = 0;
    while (true) {
      const e = await Promise.race([
        stream1.readLine(200).catch(() => null),
        delay(200).then(() => null),
      ]);
      if (!e) break;
      startupEvents++;
    }
    log(`  (drained ${startupEvents} shell startup events)`);

    // Type something in pane A
    stream1.send({
      type: "write",
      sessionId: PANE_A,
      data: "echo PANE_A_MARKER_12345\n",
    });

    // Collect output events until we see our marker or timeout
    let gotPaneAOutput = false;
    const readStart = Date.now();
    while (Date.now() - readStart < 5000) {
      try {
        const event = await stream1.readLine(2000);
        if (
          event.type === "data" &&
          event.sessionId === PANE_A &&
          event.data.includes("PANE_A_MARKER_12345")
        ) {
          gotPaneAOutput = true;
          break;
        }
      } catch {
        break;
      }
    }
    assert(gotPaneAOutput, "stream receives PTY output from pane A");

    // Check snapshot has content (use a separate control socket to avoid data events)
    const snapCtrl = await connectControl(SOCKET_PATH);
    snapCtrl.send({ type: "getSnapshot", sessionId: PANE_A });
    const snapA = await snapCtrl.readLine();
    assertEq(snapA.type, "snapshot", "snapshot A returned");
    assert(
      snapA.snapshot.screenAnsi.length > 0,
      "snapshot A has content (length: " +
        snapA.snapshot.screenAnsi.length +
        ")",
    );
    snapCtrl.close();

    // Check scrollback on disk
    await delay(500); // let flush timer fire
    const scrollbackDir = path.join(SESSIONS_DIR, PANE_A);
    assert(
      fs.existsSync(scrollbackDir),
      "pane A scrollback dir exists on disk",
    );

    const metaPath = path.join(scrollbackDir, "meta.json");
    assert(fs.existsSync(metaPath), "pane A meta.json exists on disk");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      assertEq(meta.sessionId, PANE_A, "meta.json sessionId matches");
      assertEq(meta.endedAt, null, "meta.json endedAt is null (alive)");
    }

    // Save layout (like app-store would)
    const layout = {
      version: 1,
      workspaces: [
        {
          workspacePath: WORKSPACE_PATH,
          sessions: [
            {
              id: "tab-1",
              title: "Terminal",
              rootNode: {
                type: "split",
                direction: "horizontal",
                ratio: 0.5,
                first: { type: "leaf", paneId: PANE_A },
                second: { type: "leaf", paneId: PANE_B },
              },
              focusedPaneId: PANE_A,
              paneSessions: {
                [PANE_A]: { daemonSessionId: PANE_A, lastCwd: "/tmp" },
                [PANE_B]: { daemonSessionId: PANE_B, lastCwd: "/tmp" },
              },
            },
          ],
          selectedSessionId: "tab-1",
        },
      ],
    };
    fs.mkdirSync(MANOR_DIR, { recursive: true });
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2));
    assert(fs.existsSync(LAYOUT_FILE), "layout.json saved to disk");

    // List sessions
    ctrl1.send({ type: "listSessions" });
    const list1 = await ctrl1.readLine();
    assertEq(list1.type, "sessions", "listSessions works");
    assert(
      list1.sessions.length >= 2,
      `daemon has >= 2 sessions (has ${list1.sessions.length})`,
    );

    // Disconnect (simulate app quit)
    log("\n  Disconnecting (simulating app quit)...");
    stream1.close();
    ctrl1.close();
    await delay(300);

    // ── Phase 2: Verify daemon survived ──
    log("\nPhase 2: Verify daemon survived app quit");

    assert(
      fs.existsSync(SOCKET_PATH),
      "daemon socket still exists after disconnect",
    );

    let pid;
    try {
      pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
      process.kill(pid, 0);
      assert(true, "daemon process still alive (pid " + pid + ")");
    } catch {
      assert(false, "daemon process still alive");
    }

    // ── Phase 3: Second "app session" — warm restore ──
    log("\nPhase 3: Second app session (warm restore)");

    // Load layout from disk (like loadPersistedLayout would)
    const loadedLayout = JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf-8"));
    assert(loadedLayout.workspaces.length > 0, "layout loaded from disk");

    const workspace = loadedLayout.workspaces.find(
      (w) => w.workspacePath === WORKSPACE_PATH,
    );
    assert(!!workspace, "our workspace found in layout");

    const ctrl2 = await connectControl(SOCKET_PATH);

    // List sessions — our sessions should still be there
    ctrl2.send({ type: "listSessions" });
    const list2 = await ctrl2.readLine();
    const sessionIds = list2.sessions.map((s) => s.sessionId);
    assert(sessionIds.includes(PANE_A), "daemon still has pane A session");
    assert(sessionIds.includes(PANE_B), "daemon still has pane B session");

    // Attach to pane A (like createOrAttach would)
    ctrl2.send({ type: "attach", sessionId: PANE_A });
    const attachA = await ctrl2.readLine();
    assertEq(
      attachA.type,
      "attached",
      "warm restore: attach to pane A succeeds",
    );
    assert(
      attachA.snapshot.screenAnsi.length > 0,
      "warm restore: snapshot A has content",
    );
    assertContains(
      attachA.snapshot.screenAnsi,
      "PANE_A_MARKER_12345",
      "warm restore: snapshot contains typed text",
    );

    // Subscribe stream and verify new data flows
    const stream2 = await connectStream(SOCKET_PATH);
    stream2.send({ type: "subscribe", sessionId: PANE_A });
    await delay(200);

    stream2.send({
      type: "write",
      sessionId: PANE_A,
      data: "echo AFTER_RESTORE_67890\n",
    });
    let gotPostRestoreOutput = false;
    try {
      const event = await stream2.readLine(3000);
      gotPostRestoreOutput = event.type === "data";
    } catch {}
    assert(gotPostRestoreOutput, "warm restore: new data flows after reattach");

    stream2.close();
    ctrl2.close();
    await delay(300);

    // ── Phase 4: Kill daemon, test cold restore data ──
    log("\nPhase 4: Kill daemon, verify cold restore data on disk");

    killDaemon();
    await delay(500);

    assert(
      !fs.existsSync(SOCKET_PATH) ||
        (() => {
          try {
            net.createConnection(SOCKET_PATH).destroy();
            return false;
          } catch {
            return true;
          }
        })(),
      "daemon is dead",
    );

    // Scrollback should be on disk
    const scrollbackBin = path.join(SESSIONS_DIR, PANE_A, "scrollback.bin");
    assert(
      fs.existsSync(scrollbackBin),
      "scrollback.bin exists after daemon death",
    );
    if (fs.existsSync(scrollbackBin)) {
      const content = fs.readFileSync(scrollbackBin, "utf-8");
      assert(
        content.length > 0,
        "scrollback.bin has content (length: " + content.length + ")",
      );
      assertContains(
        content,
        "PANE_A_MARKER_12345",
        "scrollback.bin contains typed text",
      );
    }

    // Meta should show unclean shutdown (daemon was killed, no endedAt)
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      assertEq(
        meta.endedAt,
        null,
        "meta.json endedAt still null (unclean shutdown)",
      );
    }

    // Layout file should still be there
    assert(fs.existsSync(LAYOUT_FILE), "layout.json survives daemon death");

    // ── Phase 5: New daemon, cold restore scenario ──
    log("\nPhase 5: New daemon (cold restore scenario)");

    await ensureDaemonRunning();

    const ctrl3 = await connectControl(SOCKET_PATH);

    // New daemon has no sessions
    ctrl3.send({ type: "listSessions" });
    const list3 = await ctrl3.readLine();
    const hasOldSessions = list3.sessions.some((s) => s.sessionId === PANE_A);
    assert(
      !hasOldSessions,
      "new daemon does NOT have old sessions (they're gone)",
    );

    // But we can read scrollback from disk
    if (fs.existsSync(scrollbackBin)) {
      const coldContent = fs.readFileSync(scrollbackBin, "utf-8");
      assertContains(
        coldContent,
        "PANE_A_MARKER_12345",
        "cold restore: scrollback readable from disk",
      );
    }

    // Create a fresh session in the old CWD (what the app would do on cold restore)
    ctrl3.send({
      type: "create",
      sessionId: PANE_A + "-restored",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    const coldCreate = await ctrl3.readLine();
    assertEq(
      coldCreate.type,
      "created",
      "cold restore: new session created in old CWD",
    );

    ctrl3.close();

    // ── Cleanup ──
    log("\nCleaning up...");
    killDaemon();
    await delay(300);
    cleanupTestSessions([PANE_A, PANE_B, PANE_A + "-restored"]);
    try {
      // Remove only our test workspace from layout, not the whole file
      if (fs.existsSync(LAYOUT_FILE)) {
        const l = JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf-8"));
        l.workspaces = l.workspaces.filter(
          (w) => w.workspacePath !== WORKSPACE_PATH,
        );
        if (l.workspaces.length > 0) {
          fs.writeFileSync(LAYOUT_FILE, JSON.stringify(l, null, 2));
        } else {
          fs.unlinkSync(LAYOUT_FILE);
        }
      }
    } catch {}
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    console.error(e.stack);
    failed++;
  }

  log("\n========================");
  log(`Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    log("\nFailed:");
    for (const e of errors) log(`  - ${e}`);
  }

  killDaemon();
  process.exit(failed > 0 ? 1 : 0);
}

main();
