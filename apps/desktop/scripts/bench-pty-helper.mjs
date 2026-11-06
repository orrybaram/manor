#!/usr/bin/env node
/**
 * Benchmark the per-pane PTY helper: today's `pty-subprocess.js` (`--impl
 * node`) against the native `manor-pty` binary (`--impl native`).
 *
 * It plays the daemon's part: starts helpers, speaks the frame protocol in
 * `electron/terminal-host/pty-subprocess-ipc.ts` to them, and measures.
 *
 *   B1 idle memory    N panes at an idle shell prompt
 *   B2 burst memory   each pane prints a lot of output to a slow reader
 *   B3 throughput     one pane prints 500 MB
 *   B4 echo latency   keystrokes echoed back through a raw-mode `cat`
 *   B5 detection      N fake agents: helper CPU and processes it starts
 *   B6 correctness    multibyte stream arrives intact; foreground names
 *
 * Usage (from apps/desktop, after `vite build` for the node impl):
 *   pnpm bench:pty --impl node
 *   pnpm bench:pty --impl native --only B1,B4 --out results.jsonl
 *
 * Options:
 *   --impl node|native     which helper (default node)
 *   --runtime electron|node  what runs pty-subprocess.js (default electron,
 *                          as in the desktop app; node-pty is rebuilt for it)
 *   --helper <path>        native binary (default native/manor-pty/target/release/manor-pty)
 *   --only B1,B2,...       subset of benchmarks
 *   --panes <n>            panes for B1 and B5 (default 18)
 *   --out <file>           append JSON lines here as well
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);

// ── Options ──

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const impl = opt("impl", "node");
const runtime = opt("runtime", "electron");
const helperPath = path.resolve(
  desktopDir,
  opt("helper", "native/manor-pty/target/release/manor-pty"),
);
const only = new Set(opt("only", "B1,B2,B3,B4,B5,B6").split(","));
const PANES = Number(opt("panes", "18"));
const outFile = opt("out", null);
const isLinux = process.platform === "linux";

if (!["node", "native"].includes(impl))
  throw new Error(`--impl must be node or native`);
if (impl === "native" && !fs.existsSync(helperPath)) {
  throw new Error(
    `No native helper at ${helperPath}; build it with cargo build --release`,
  );
}
const subprocessJs = path.join(
  desktopDir,
  "dist-electron",
  "pty-subprocess.js",
);
if (impl === "node" && !fs.existsSync(subprocessJs)) {
  throw new Error(`No ${subprocessJs}; run vite build first`);
}

// ── Frame protocol (mirror of pty-subprocess-ipc.ts) ──

const MSG = {
  SPAWN: 0x01,
  WRITE: 0x02,
  RESIZE: 0x03,
  KILL: 0x04,
  SIGNAL: 0x05,
  DISPOSE: 0x06,
  PAUSE: 0x07,
  RESUME: 0x08,
  READY: 0x11,
  SPAWNED: 0x12,
  DATA: 0x13,
  EXIT: 0x14,
  ERROR: 0x15,
  FGPROC: 0x16,
  RESIZED: 0x17,
};

function frame(type, payload = Buffer.alloc(0)) {
  const buf =
    typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const out = Buffer.allocUnsafe(5 + buf.length);
  out[0] = type;
  out.writeUInt32BE(buf.length, 1);
  buf.copy(out, 5);
  return out;
}

class Decoder {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = Buffer.from(this.buf.subarray(5, 5 + len));
      this.buf = this.buf.subarray(5 + len);
      this.onFrame(type, payload);
    }
  }
}

// ── A pane: one helper process, driven like the daemon drives it ──

function electronPath() {
  return require(path.join(desktopDir, "node_modules", "electron"));
}

const shellEnv = {
  ...process.env,
  TERM: "xterm-256color",
  // Keep shells free of the user's rc files so runs are comparable.
  HISTFILE: "/dev/null",
  PS1: "$ ",
};

class Pane {
  constructor({
    shell,
    args = [],
    cwd = os.tmpdir(),
    cols = 120,
    rows = 40,
    env = shellEnv,
    extraEnv = {},
  }) {
    this.spawnPayload = {
      shell,
      args,
      cwd,
      cols,
      rows,
      env: { ...env, ...extraEnv },
    };
    this.listeners = new Set();
    this.dataBytes = 0;
    this.fgNames = [];
    this.exited = null;
    this.helperEnv = { ...process.env, ...extraEnv };
  }

  start() {
    const child =
      impl === "native"
        ? spawn(helperPath, [], {
            stdio: ["pipe", "pipe", "inherit"],
            env: this.helperEnv,
          })
        : spawn(
            runtime === "electron" ? electronPath() : process.execPath,
            [subprocessJs],
            {
              stdio: ["pipe", "pipe", "inherit"],
              env: { ...this.helperEnv, ELECTRON_RUN_AS_NODE: "1" },
            },
          );
    this.child = child;
    this.decoder = new Decoder((type, payload) => this.onFrame(type, payload));
    child.stdout.on("data", (c) => this.decoder.push(c));
    this.helperExit = new Promise((r) => child.on("exit", r));
    this.spawned = new Promise((resolve, reject) => {
      this.resolveSpawned = resolve;
      this.rejectSpawned = reject;
    });
    return this.spawned;
  }

  onFrame(type, payload) {
    switch (type) {
      case MSG.READY:
        this.send(MSG.SPAWN, JSON.stringify(this.spawnPayload));
        break;
      case MSG.SPAWNED:
        this.pid = JSON.parse(payload.toString()).pid;
        this.resolveSpawned(this.pid);
        break;
      case MSG.DATA:
        this.dataBytes += payload.length;
        break;
      case MSG.EXIT:
        this.exited = JSON.parse(payload.toString()).exitCode;
        break;
      case MSG.ERROR:
        this.rejectSpawned(new Error(JSON.parse(payload.toString()).message));
        break;
      case MSG.FGPROC:
        this.fgNames.push(JSON.parse(payload.toString()).name);
        break;
    }
    for (const l of this.listeners) l(type, payload);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  send(type, payload) {
    this.child.stdin.write(frame(type, payload));
  }
  write(text) {
    this.send(MSG.WRITE, text);
  }

  waitFor(pred, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error("timed out"));
      }, timeoutMs);
      const off = this.on((type, payload) => {
        if (pred(type, payload)) {
          clearTimeout(t);
          off();
          resolve(payload);
        }
      });
    });
  }

  untilExit(timeoutMs = 600_000) {
    if (this.exited !== null) return Promise.resolve(this.exited);
    return this.waitFor((t) => t === MSG.EXIT, timeoutMs).then(
      () => this.exited,
    );
  }

  async dispose() {
    if (this.child.exitCode !== null) return;
    try {
      this.send(MSG.DISPOSE);
    } catch {
      /* gone */
    }
    const t = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.helperExit;
    clearTimeout(t);
  }
}

// ── Measurement ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resident and proportional memory of one process, in KB. */
function memory(pid) {
  if (isLinux) {
    const roll = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf-8");
    const field = (name) =>
      Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(roll)?.[1] ?? 0);
    return { rss: field("Rss"), pss: field("Pss") };
  }
  const rss = Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf-8",
    }).trim(),
  );
  return { rss, pss: null };
}

/** CPU seconds of a process: its own, and its reaped children's (Linux). */
function cpuSeconds(pid) {
  if (isLinux) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const tick = 100; // USER_HZ
    return {
      self: (Number(f[11]) + Number(f[12])) / tick,
      children: (Number(f[13]) + Number(f[14])) / tick,
    };
  }
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], {
    encoding: "utf-8",
  }).trim();
  const [m, s] = t.split(":");
  return { self: Number(m) * 60 + Number(s), children: null };
}

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const pct = (p) =>
    v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: v[0],
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    max: v[v.length - 1],
    mean: sum / v.length,
    sum,
  };
}

const mb = (kb) => Math.round((kb / 1024) * 10) / 10;

function report(bench, result) {
  const line = {
    bench,
    impl,
    runtime: impl === "node" ? runtime : null,
    platform: `${process.platform}-${process.arch}`,
    at: new Date().toISOString(),
    ...result,
  };
  console.log(JSON.stringify(line));
  if (outFile) fs.appendFileSync(outFile, JSON.stringify(line) + "\n");
  return line;
}

function idleShell() {
  for (const [shell, args] of [
    ["/bin/zsh", ["-f", "-i"]],
    ["/bin/bash", ["--norc", "--noprofile", "-i"]],
    ["/bin/sh", ["-i"]],
  ]) {
    if (fs.existsSync(shell)) return { shell, args };
  }
  throw new Error("no shell");
}

async function startPanes(n, spec) {
  const panes = Array.from(
    { length: n },
    () => new Pane(typeof spec === "function" ? spec() : spec),
  );
  await Promise.all(panes.map((p) => p.start()));
  return panes;
}

async function disposeAll(panes) {
  await Promise.all(panes.map((p) => p.dispose()));
}

// ── B1 idle memory ──

async function b1() {
  const panes = await startPanes(PANES, idleShell());
  await sleep(20_000);
  const mems = panes.map((p) => memory(p.child.pid));
  await disposeAll(panes);
  const rss = stats(mems.map((m) => m.rss));
  const pss = isLinux ? stats(mems.map((m) => m.pss)) : null;
  return report("B1", {
    panes: PANES,
    rssMbPerPane: { p50: mb(rss.p50), max: mb(rss.max) },
    rssMbTotal: mb(rss.sum),
    pssMbPerPane: pss && { p50: mb(pss.p50), max: mb(pss.max) },
    pssMbTotal: pss && mb(pss.sum),
  });
}

// ── B2 burst memory: lots of output, read slowly ──

async function b2() {
  const PANES_B2 = 4;
  const BYTES = 100 * 1024 * 1024;
  const cmd = `yes 'manor burst 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ' | head -c ${BYTES}`;
  const panes = await startPanes(PANES_B2, {
    shell: "/bin/sh",
    args: ["-c", cmd],
  });
  const peaks = panes.map(() => 0);
  // A slow daemon: stop reading the helper's stdout for 50 ms per MB read.
  for (const p of panes) {
    let sinceBreak = 0;
    p.child.stdout.on("data", (c) => {
      sinceBreak += c.length;
      if (sinceBreak >= 1024 * 1024) {
        sinceBreak = 0;
        p.child.stdout.pause();
        setTimeout(() => p.child.stdout.resume(), 50);
      }
    });
  }
  const sampler = setInterval(() => {
    panes.forEach((p, i) => {
      try {
        peaks[i] = Math.max(peaks[i], memory(p.child.pid).rss);
      } catch {
        /* exiting */
      }
    });
  }, 100);
  const t0 = performance.now();
  await Promise.all(panes.map((p) => p.untilExit()));
  const seconds = (performance.now() - t0) / 1000;
  await sleep(5_000);
  clearInterval(sampler);
  const settled = panes.map((p) => memory(p.child.pid).rss);
  await disposeAll(panes);
  const peak = stats(peaks);
  return report("B2", {
    panes: PANES_B2,
    mbPerPane: BYTES / 1024 / 1024,
    seconds: Math.round(seconds * 10) / 10,
    peakRssMbPerPane: { p50: mb(peak.p50), max: mb(peak.max) },
    settledRssMbPerPane: {
      p50: mb(stats(settled).p50),
      max: mb(stats(settled).max),
    },
    bytesRead: panes.map((p) => p.dataBytes),
  });
}

// ── B3 throughput ──

async function b3() {
  const BYTES = 500 * 1024 * 1024;
  const cmd = `yes 'manor throughput 0123456789 abcdefghijklmnopqrstuvwxyz' | head -c ${BYTES}`;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const [p] = await startPanes(1, { shell: "/bin/sh", args: ["-c", cmd] });
    let t0 = null;
    p.on((type) => {
      if (type === MSG.DATA && t0 === null) t0 = performance.now();
    });
    await p.untilExit();
    const seconds = (performance.now() - t0) / 1000;
    runs.push(p.dataBytes / 1024 / 1024 / seconds);
    await p.dispose();
  }
  const s = stats(runs);
  return report("B3", {
    mb: BYTES / 1024 / 1024,
    mbPerSec: { median: Math.round(s.p50), runs: runs.map(Math.round) },
  });
}

// ── B4 echo latency ──

async function b4() {
  const [p] = await startPanes(1, {
    shell: "/bin/sh",
    args: ["-c", "stty raw -echo; echo ready; exec cat"],
  });
  await p.waitFor(
    (t, payload) => t === MSG.DATA && payload.toString().includes("ready"),
  );
  await sleep(500);
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    const ch = String.fromCharCode(97 + (i % 26));
    const got = p.waitFor(
      (t, payload) => t === MSG.DATA && payload.toString().includes(ch),
      5000,
    );
    const t0 = process.hrtime.bigint();
    p.write(ch);
    await got;
    samples.push(Number(process.hrtime.bigint() - t0) / 1000);
    await sleep(2);
  }
  await p.dispose();
  const s = stats(samples);
  return report("B4", {
    samples: s.n,
    echoUs: {
      p50: Math.round(s.p50),
      p90: Math.round(s.p90),
      p99: Math.round(s.p99),
      max: Math.round(s.max),
    },
  });
}

// ── B5 detection cost ──

/**
 * A stand-in agent: `node` titled with a version string, the way Claude Code
 * names itself, with a child whose command line says `claude`.
 */
function fakeAgentCommand() {
  const child = `setInterval(()=>{},1e9)`;
  const parent =
    `process.title='2.1.80';` +
    `require('child_process').spawn(process.execPath,['-e','${child}','claude'],{stdio:'ignore'});` +
    `setInterval(()=>{},1e9)`;
  return `exec node -e "${parent}"`;
}

/** A PATH directory whose pgrep and ps log each call, then run the real one. */
function spawnCounterDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-bench-shim-"));
  const log = path.join(dir, "calls.log");
  for (const tool of ["pgrep", "ps"]) {
    const real = execFileSync("sh", ["-c", `command -v ${tool}`], {
      encoding: "utf-8",
    }).trim();
    fs.writeFileSync(
      path.join(dir, tool),
      `#!/bin/sh\nprintf '${tool}\\n' >> '${log}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { dir, log };
}

async function b5() {
  const SECONDS = 60;
  // Phase 1: CPU with the real tools.
  let panes = await startPanes(PANES, {
    shell: "/bin/sh",
    args: ["-c", fakeAgentCommand()],
  });
  await Promise.all(
    panes.map((p) =>
      p
        .waitFor(
          (t, payload) =>
            t === MSG.FGPROC &&
            JSON.parse(payload.toString()).name === "claude",
          15_000,
        )
        .catch(() => null),
    ),
  );
  const detected = panes.filter((p) => p.fgNames.includes("claude")).length;
  const before = panes.map((p) => cpuSeconds(p.child.pid));
  await sleep(SECONDS * 1000);
  const after = panes.map((p) => cpuSeconds(p.child.pid));
  await disposeAll(panes);
  const self = after.reduce((s, a, i) => s + a.self - before[i].self, 0);
  const children = isLinux
    ? after.reduce((s, a, i) => s + a.children - before[i].children, 0)
    : null;

  // Phase 2: count the processes the helpers start, through a logging PATH shim.
  const shim = spawnCounterDir();
  const COUNT_SECONDS = 20;
  const extraEnv = { PATH: `${shim.dir}:${process.env.PATH}` };
  panes = await startPanes(PANES, {
    shell: "/bin/sh",
    args: ["-c", fakeAgentCommand()],
    extraEnv,
  });
  await sleep(3000);
  fs.writeFileSync(shim.log, "");
  await sleep(COUNT_SECONDS * 1000);
  const calls = fs
    .readFileSync(shim.log, "utf-8")
    .split("\n")
    .filter(Boolean).length;
  await disposeAll(panes);
  fs.rmSync(shim.dir, { recursive: true, force: true });

  return report("B5", {
    panes: PANES,
    detected,
    seconds: SECONDS,
    cpuSecondsSelf: Math.round(self * 100) / 100,
    cpuSecondsChildren:
      children === null ? null : Math.round(children * 100) / 100,
    cpuPercentOfOneCore:
      Math.round(((self + (children ?? 0)) / SECONDS) * 1000) / 10,
    spawnsPerSecond: Math.round((calls / COUNT_SECONDS) * 10) / 10,
  });
}

// ── B6 correctness ──

/** 8 MB of mixed ASCII, CJK, emoji and combining marks, in lines. */
function multibyteFixture() {
  const pieces = [
    "manor ",
    "终端 ",
    "ターミナル ",
    "🦀🧪👩‍💻 ",
    "é́ ",
    "ﷺ ",
    "𝔐𝔞𝔫𝔬𝔯 ",
    "x",
  ];
  let seed = 7;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lines = [];
  let size = 0;
  while (size < 8 * 1024 * 1024) {
    let line = "";
    const n = 1 + Math.floor(rand() * 40);
    for (let i = 0; i < n; i++)
      line += pieces[Math.floor(rand() * pieces.length)];
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return lines.join("\n") + "\n";
}

async function b6Stream() {
  const text = multibyteFixture();
  const file = path.join(os.tmpdir(), `manor-bench-utf8-${process.pid}.txt`);
  fs.writeFileSync(file, text);
  const [p] = await startPanes(1, {
    shell: "/bin/sh",
    args: ["-c", `stty -onlcr; cat '${file}'`],
  });
  const chunks = [];
  let invalidFrames = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  p.on((type, payload) => {
    if (type !== MSG.DATA) return;
    chunks.push(payload);
    try {
      decoder.decode(payload);
    } catch {
      invalidFrames++;
    }
  });
  await p.untilExit();
  await sleep(200);
  await p.dispose();
  fs.rmSync(file);
  const got = Buffer.concat(chunks);
  const want = Buffer.from(text);
  return {
    frames: chunks.length,
    invalidFrames,
    identical: got.equals(want),
    bytes: got.length,
    expectedBytes: want.length,
  };
}

/** Foreground names reported for each scenario, in order (deduplicated). */
async function b6Names() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-bench-fg-"));
  const script = path.join(dir, "manor-e2e-agent");
  fs.writeFileSync(script, "#!/bin/sh\nsleep 1000\n", { mode: 0o755 });
  const { shell, args } = idleShell();
  const scenarios = [
    ["idle shell", null],
    ["plain program", "sleep 1000"],
    ["fake agent", fakeAgentCommand().replace(/^exec /, "")],
    ["script wrapper", script],
  ];
  const results = {};
  for (const [name, command] of scenarios) {
    const [p] = await startPanes(1, { shell, args, cwd: dir });
    await sleep(1500);
    if (command) p.write(`${command}\r`);
    await sleep(3000);
    results[name] = [...new Set(p.fgNames)];
    await p.dispose();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

async function b6() {
  const stream = await b6Stream();
  const names = await b6Names();
  return report("B6", { stream, names });
}

// ── Main ──

const benches = { B1: b1, B2: b2, B3: b3, B4: b4, B5: b5, B6: b6 };
console.error(
  `bench-pty-helper: impl=${impl}${impl === "node" ? ` runtime=${runtime}` : ` helper=${helperPath}`} ${process.platform}-${process.arch}`,
);
const results = [];
for (const [name, fn] of Object.entries(benches)) {
  if (!only.has(name)) continue;
  console.error(`running ${name}…`);
  results.push(await fn());
}

console.error("\nsummary");
for (const r of results) {
  const { bench, impl: _i, runtime: _r, platform: _p, at: _a, ...rest } = r;
  console.error(`  ${bench}  ${JSON.stringify(rest)}`);
}
process.exit(0);
