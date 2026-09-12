#!/usr/bin/env node
/**
 * Record what the renderer is doing, from outside the renderer.
 *
 * DevTools shares the main thread with the page it is measuring. On a pane
 * that is already janking that makes it both inaccurate and, often, unusable —
 * it competes for the very thread whose contention is the thing under
 * investigation. This attaches over CDP from a separate process instead, so
 * the recording costs the app almost nothing.
 *
 * Usage:
 *
 *   # 1. start the app with a debugging port
 *   MANOR_DEBUG_PORT=9333 pnpm dev
 *
 *   # 2. run this, then do the slow thing while it counts down
 *   node scripts/profile-renderer.mjs --seconds 8
 *
 * Writes a `.cpuprofile` next to the summary, which can be dragged into the
 * DevTools Performance panel later — on a machine that is not busy.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const seconds = Number(readFlag("--seconds") ?? 8);
const port = readFlag("--port") ?? process.env.MANOR_DEBUG_PORT ?? "9333";
const outDir = readFlag("--out") ?? ".";
const wsOverride = readFlag("--ws");

function readFlag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Chromium's CDP discovery endpoint rejects any Host header that is not
 * `localhost`, so connecting to `127.0.0.1` and letting the client set the Host
 * itself hangs rather than fails. Ask for it explicitly, then hand Playwright
 * the WebSocket URL — which needs no discovery at all.
 */
async function findWebSocketUrl() {
  if (wsOverride) return wsOverride;
  // The port is listening well before it will answer — the endpoint only comes
  // up once the first window's contents have settled, which on a cold start is
  // a good few seconds after launch. Retry rather than fail on the first try.
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      return await requestWebSocketUrl();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function requestWebSocketUrl() {
  const body = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: Number(port),
        path: "/json/version",
        headers: { Host: `localhost:${port}` },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => resolve(data));
      },
    );
    request.on("error", reject);
    request.setTimeout(4000, () => {
      request.destroy();
      reject(
        new Error(
          "the debugging port accepted the connection but never answered",
        ),
      );
    });
  });
  return JSON.parse(body).webSocketDebuggerUrl;
}

console.log(`Looking for a renderer on port ${port}…`);
const wsUrl = await findWebSocketUrl().catch((err) => {
  console.error(
    `Could not reach the debugging port on ${port}: ${err.message}\n\n` +
      `Start the app with:   MANOR_DEBUG_PORT=${port} pnpm dev\n` +
      `It prints a line like "DevTools listening on ws://127.0.0.1:${port}/devtools/browser/...".\n` +
      `If discovery keeps failing, paste that URL:  --ws <url>`,
  );
  process.exit(1);
});

const browser = await chromium.connectOverCDP(wsUrl).catch((err) => {
  console.error(`Attaching to ${wsUrl} failed.\n\n${err.message}`);
  process.exit(1);
});

const pages = browser.contexts().flatMap((context) => context.pages());
const page =
  pages.find((candidate) => !candidate.url().startsWith("devtools://")) ??
  pages[0];
if (!page) {
  console.error("Attached, but the app has no renderer page open.");
  process.exit(1);
}

// Which build this is, spelled out. Two Manor windows look identical, and a
// profile of the installed app when you meant the dev build is a trace that
// cannot answer the question you are asking.
const loadedFrom = await page.evaluate(() => {
  const script = [...document.querySelectorAll("script[src]")]
    .map((el) => el.src)
    .find((src) => src.includes("/assets/"));
  return { href: location.href, script: script ?? "(none)" };
});
console.log(`Attached to: ${await page.title()}`);
console.log(`  page    ${loadedFrom.href}`);
console.log(`  bundle  ${loadedFrom.script}`);
if (loadedFrom.href.includes("app.asar")) {
  console.log(
    `\n  ⚠  This is the INSTALLED app, not a dev build. It does not contain\n` +
      `     your working tree. Quit /Applications/Manor.app, or attach to the\n` +
      `     window titled "Manor (<branch>)" instead.`,
  );
}

const session = await page.context().newCDPSession(page);
await session.send("Performance.enable");
await session.send("Profiler.enable");
await session.send("Profiler.setSamplingInterval", { interval: 100 });

// The frame clock has to live in the page: a rAF callback only runs once per
// frame the renderer actually produced, so the gaps between its ticks are
// exactly the stretches where the user saw nothing move.
await page.evaluate(() => {
  const state = { t0: performance.now(), frames: [], longTasks: [] };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.longTasks.push({
        startMs: Math.round(entry.startTime - state.t0),
        durationMs: Math.round(entry.duration),
      });
    }
  });
  observer.observe({ entryTypes: ["longtask"] });
  const tick = () => {
    state.frames.push(performance.now() - state.t0);
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
  state.stop = () => {
    cancelAnimationFrame(state.raf);
    observer.disconnect();
  };
  window.__manorProfile = state;
});

const before = await metrics(session);
await session.send("Profiler.start");

console.log(`\nRecording for ${seconds}s — do the slow thing now.\n`);
for (let i = seconds; i > 0; i--) {
  process.stdout.write(`\r  ${i}s remaining   `);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
process.stdout.write("\r                     \r");

const { profile } = await session.send("Profiler.stop");
const after = await metrics(session);
const page_ = await page.evaluate(() => {
  const state = window.__manorProfile;
  state.stop();
  const frames = state.frames;
  delete window.__manorProfile;
  return { frames, longTasks: state.longTasks };
});

const gaps = [];
for (let i = 1; i < page_.frames.length; i++) {
  gaps.push(page_.frames[i] - page_.frames[i - 1]);
}
gaps.sort((a, b) => a - b);

console.log("── frames ──");
console.log(`  produced        ${page_.frames.length} in ${seconds}s`);
console.log(`  median gap      ${fmt(gaps[Math.floor(gaps.length / 2)])}`);
console.log(`  95th pct gap    ${fmt(gaps[Math.floor(gaps.length * 0.95)])}`);
console.log(`  worst gap       ${fmt(gaps[gaps.length - 1])}`);
console.log(`  gaps over 100ms ${gaps.filter((g) => g > 100).length}`);

console.log("\n── main thread ──");
for (const [name, label] of [
  ["ScriptDuration", "script"],
  ["RecalcStyleDuration", "style"],
  ["LayoutDuration", "layout"],
]) {
  const spent = ((after[name] ?? 0) - (before[name] ?? 0)) * 1000;
  console.log(
    `  ${label.padEnd(7)} ${Math.round(spent)}ms (${((spent / (seconds * 1000)) * 100).toFixed(1)}% of the window)`,
  );
}
console.log(`  long tasks   ${page_.longTasks.length}`);
for (const task of page_.longTasks.slice(0, 12)) {
  console.log(`      +${task.startMs}ms for ${task.durationMs}ms`);
}

console.log("\n── hottest frames (self time) ──");
for (const line of hottest(profile)) console.log(line);

const file = path.join(
  outDir,
  `manor-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`,
);
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`\nFull profile written to ${file}`);
console.log("Drag it into the DevTools Performance panel to explore it.");

await browser.close();

async function metrics(session) {
  const { metrics } = await session.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

function fmt(value) {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

/** Self time per call frame, hottest first. */
function hottest(profile, top = 20) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicros = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[i] ?? 0));
  }
  const total = [...selfMicros.values()].reduce((a, b) => a + b, 0) || 1;

  return [...selfMicros.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([id, micros]) => {
      const frame = byId.get(id)?.callFrame;
      const name = frame?.functionName || "(anonymous)";
      const where = frame?.url
        ? `${frame.url.split("/").slice(-1)[0]}:${(frame.lineNumber ?? 0) + 1}`
        : "";
      return `  ${(micros / 1000).toFixed(1).padStart(8)}ms  ${((micros / total) * 100).toFixed(1).padStart(5)}%  ${name} ${where}`;
    });
}
