#!/usr/bin/env node
/**
 * Real daemon, real shells: checks the built terminal host picks the PTY
 * helper it should and that a pane works through it.
 *
 * For each mode it starts dist-electron/terminal-host-index.js under a
 * throwaway HOME (so it can't touch a real daemon), creates sessions over
 * the control socket, has each shell write a file, checks which helper
 * process holds the pane, resizes, and kills the session.
 *
 *   native     default: manor-pty from native/manor-pty/target/release
 *   node       MANOR_PTY_HELPER=node
 *   fallback   MANOR_PTY_HELPER_PATH = an executable that isn't a program
 *
 * Usage (after vite build and cargo build --release):
 *   node scripts/test-pty-helper-daemon.mjs [native|node|fallback ...]
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);
const electron = require(path.join(desktopDir, "node_modules", "electron"));
const daemonJs = path.join(
  desktopDir,
  "dist-electron",
  "terminal-host-index.js",
);
const modes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["native", "node", "fallback"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function control(socketPath) {
  const socket = net.createConnection(socketPath);
  let buf = "";
  const waiting = [];
  socket.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      waiting.shift()?.(JSON.parse(line));
    }
  });
  const ready = new Promise((r, j) => {
    socket.once("connect", r);
    socket.once("error", j);
  });
  return {
    ready,
    request: (msg) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        socket.write(JSON.stringify(msg) + "\n");
      }),
    close: () => socket.destroy(),
  };
}

/** Helper processes whose parent is `daemonPid`, by kind. */
function helpersOf(daemonPid) {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf-8",
  });
  const kinds = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, ...args] = line.trim().split(/\s+/);
    if (Number(ppid) !== daemonPid) continue;
    const cmd = args.join(" ");
    if (/manor-pty/.test(cmd)) kinds.push({ pid: Number(pid), kind: "native" });
    else if (/pty-subprocess\.js/.test(cmd))
      kinds.push({ pid: Number(pid), kind: "node" });
  }
  return kinds;
}

async function runMode(mode) {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), `manor-pty-daemon-${mode}-`),
  );
  // bash: writeAfterReady goes after its first output; zsh would wait for
  // the prompt mark that only the app's rc files set up.
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/bash",
    ELECTRON_RUN_AS_NODE: "1",
  };
  delete env.MANOR_PTY_HELPER;
  delete env.MANOR_PTY_HELPER_PATH;
  if (mode === "node") env.MANOR_PTY_HELPER = "node";
  if (mode === "fallback") {
    const bogus = path.join(home, "not-a-program");
    fs.writeFileSync(bogus, "\x00\x01\x02 not an executable format\n", {
      mode: 0o755,
    });
    env.MANOR_PTY_HELPER_PATH = bogus;
  }
  const expected = mode === "native" ? "native" : "node";

  const daemon = spawn(electron, [daemonJs], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr.on("data", (c) => (stderr += c));
  const dir = path.join(home, ".manor", "daemon");
  const results = [];
  try {
    await waitFor(
      () => fs.existsSync(path.join(dir, "terminal-host.token")),
      "daemon token",
    );
    const token = fs
      .readFileSync(path.join(dir, "terminal-host.token"), "utf-8")
      .trim();
    const c = control(path.join(dir, "terminal-host.sock"));
    await c.ready;
    const auth = await c.request({ type: "auth", token });
    if (auth.type !== "authOk")
      throw new Error(`auth: ${JSON.stringify(auth)}`);

    for (const n of [1, 2]) {
      const sessionId = `pty-${mode}-${n}`;
      const marker = path.join(home, `${sessionId}.txt`);
      const created = await c.request({
        type: "create",
        sessionId,
        cwd: home,
        cols: 100,
        rows: 30,
      });
      if (created.type !== "created")
        throw new Error(`create: ${JSON.stringify(created)}`);
      await c.request({
        type: "writeAfterReady",
        sessionId,
        data: `echo "ok $(stty size) $PWD" > '${marker}'\r`,
      });
      const text = await waitFor(
        () => fs.existsSync(marker) && fs.readFileSync(marker, "utf-8").trim(),
        `${sessionId} output`,
      ).catch(async (err) => {
        const snap = await c.request({ type: "getSnapshot", sessionId });
        throw new Error(
          `${err.message}; screen: ${JSON.stringify(snap).slice(0, 1500)}`,
        );
      });
      const helpers = helpersOf(daemon.pid);
      const resized = await c.request({
        type: "resize",
        sessionId,
        cols: 132,
        rows: 50,
      });
      const killed = await c.request({ type: "kill", sessionId });
      results.push({
        sessionId,
        text,
        helpers: helpers.map((h) => h.kind),
        resized: resized.type,
        killed: killed.type,
      });
    }
    await sleep(500);
    const left = helpersOf(daemon.pid).length;
    c.close();

    const ok =
      results.every(
        (r) =>
          r.text === `ok 30 100 ${home}` &&
          r.resized === "resized" &&
          r.killed === "killed",
      ) &&
      results.every(
        (r) => r.helpers.length >= 1 && r.helpers.every((k) => k === expected),
      ) &&
      left === 0 &&
      (mode !== "fallback" || /didn't start/.test(stderr));
    return {
      mode,
      ok,
      expected,
      results,
      helpersLeftAfterKill: left,
      fallbackWarned: /didn't start/.test(stderr),
    };
  } finally {
    daemon.kill("SIGTERM");
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

let failed = false;
for (const mode of modes) {
  try {
    const r = await runMode(mode);
    console.log(JSON.stringify(r));
    if (!r.ok) failed = true;
  } catch (err) {
    console.log(JSON.stringify({ mode, ok: false, error: String(err) }));
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
