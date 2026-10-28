import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { CDPSession, ElectronApplication, Page } from "@playwright/test";
import {
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
  expect,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";

/**
 * Overload benchmark: push the desktop app past normal use and record where
 * memory goes and where the main threads stop answering. A measurement, not
 * a gate — every sample lands in MANOR_PERF_OUT (JSON lines) for the report.
 *
 * The overload scenarios take minutes and gigabytes, so they only run with
 * MANOR_PERF_OVERLOAD=1; sizes come from the MANOR_PERF_* variables below.
 * A 20,000-line diff step needs more memory than an 8GB machine has.
 */

const OUT =
  process.env.MANOR_PERF_OUT ??
  path.join(__dirname, "artifacts", "overload-perf.jsonl");

const WORKSPACES = Number(process.env.MANOR_PERF_WORKSPACES ?? 12);
const FLOOD_TABS = Number(process.env.MANOR_PERF_FLOOD_TABS ?? 6);
const FLOOD_SECONDS = Number(process.env.MANOR_PERF_FLOOD_SECONDS ?? 40);
const DIFF_STEPS = (process.env.MANOR_PERF_DIFF_STEPS ?? "2000,6000")
  .split(",")
  .map(Number);

type Sample = Record<string, unknown>;

function record(scenario: string, step: string, data: Sample): void {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(
    OUT,
    JSON.stringify({ scenario, step, at: Date.now(), ...data }) + "\n",
  );
  const mb = (k: string) =>
    typeof data[k] === "number" ? `${k}=${Math.round(data[k] as number)}` : "";
  console.log(
    `[perf] ${scenario} / ${step}  ${[
      "pssTotalMB",
      "totalMB",
      "mainMB",
      "rendererMB",
      "gpuMB",
      "daemonMB",
      "jsHeapMB",
      "mainHeapMB",
      "domNodes",
      "terminals",
      "rendererPingMs",
      "mainPingMs",
    ]
      .map(mb)
      .filter(Boolean)
      .join(" ")}`,
  );
}

class Probe {
  private constructor(
    private readonly app: ElectronApplication,
    private readonly window: Page,
    private readonly cdp: CDPSession,
    private readonly tempHome: string,
  ) {}

  static async attach(
    app: ElectronApplication,
    window: Page,
    tempHome: string,
  ): Promise<Probe> {
    const cdp = await app.context().newCDPSession(window);
    await cdp.send("Performance.enable");
    return new Probe(app, window, cdp, tempHome);
  }

  /** Round trip into a JS thread; a blocked thread shows up as a long one. */
  async pings(): Promise<{ rendererPingMs: number; mainPingMs: number }> {
    const t0 = performance.now();
    await this.window.evaluate(() => 1);
    const t1 = performance.now();
    await this.app.evaluate(() => 1);
    const t2 = performance.now();
    return { rendererPingMs: t1 - t0, mainPingMs: t2 - t1 };
  }

  async sample(gc = true): Promise<Sample> {
    if (gc) await this.cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const procs = await this.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({
        type: m.type,
        pid: m.pid,
        name: m.name ?? m.serviceName ?? "",
        kb: m.memory.workingSetSize,
        cpu: m.cpu.percentCPUUsage,
      })),
    );
    const mainMem = await this.app.evaluate(() => process.memoryUsage());
    const { metrics } = await this.cdp.send("Performance.getMetrics");
    const perf = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    const terms = await this.window.evaluate(() => {
      const reg = window.__manorTerminals;
      if (!reg) return { count: 0, lines: 0 };
      let lines = 0;
      for (const handle of reg.values()) {
        lines += handle.term?.buffer.active.length ?? 0;
      }
      return { count: reg.size, lines };
    });
    const daemon = daemonRss(this.tempHome);
    // PSS, not RSS: every Electron-as-node helper maps the same binary, and
    // RSS charges each of them for all of it.
    const pssBy: Record<string, number> = {};
    for (const p of procs)
      pssBy[p.type] = (pssBy[p.type] ?? 0) + pssKb(p.pid) / 1024;
    pssBy.daemon = pssKb(daemon.pid) / 1024;
    pssBy.ptyHelpers =
      daemon.childPids.reduce((a, pid) => a + pssKb(pid), 0) / 1024;
    const sum = (type: string) =>
      procs.filter((p) => p.type === type).reduce((a, p) => a + p.kb, 0) / 1024;
    const rendererMB = sum("Tab");
    const out: Sample = {
      mainMB: sum("Browser"),
      rendererMB,
      gpuMB: sum("GPU"),
      utilityMB: sum("Utility"),
      daemonMB: daemon.daemonKb / 1024,
      ptyChildrenMB: daemon.childKb / 1024,
      ptyChildren: daemon.children,
      jsHeapMB: (perf.JSHeapUsedSize ?? 0) / 1048576,
      jsHeapTotalMB: (perf.JSHeapTotalSize ?? 0) / 1048576,
      mainHeapMB: mainMem.heapUsed / 1048576,
      mainRssMB: mainMem.rss / 1048576,
      mainExternalMB: mainMem.external / 1048576,
      mainArrayBuffersMB: mainMem.arrayBuffers / 1048576,
      domNodes: perf.Nodes,
      listeners: perf.JSEventListeners,
      documents: perf.Documents,
      frames: perf.Frames,
      terminals: terms.count,
      terminalBufferLines: terms.lines,
      processes: procs.length,
      pss: pssBy,
      pssTotalMB: Object.values(pssBy).reduce((a, b) => a + b, 0),
      procs,
      ...(await this.pings()),
    };
    out.totalMB =
      (out.mainMB as number) +
      rendererMB +
      (out.gpuMB as number) +
      (out.utilityMB as number) +
      (out.daemonMB as number);
    return out;
  }

  async cost(): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  /** Watch frames and long tasks for `ms`, returning what the user would feel. */
  async watchFrames(ms: number): Promise<Sample> {
    const before = await this.cost();
    const pingWorst = { renderer: 0, main: 0 };
    const pinger = (async () => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const p = await this.pings();
        pingWorst.renderer = Math.max(pingWorst.renderer, p.rendererPingMs);
        pingWorst.main = Math.max(pingWorst.main, p.mainPingMs);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const frames = await this.window.evaluate(async (duration) => {
      const stamps: number[] = [];
      const longTasks: number[] = [];
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration);
      });
      try {
        obs.observe({ entryTypes: ["longtask"] });
      } catch {
        /* unsupported */
      }
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (t: number) => {
          stamps.push(t);
          if (t - start < duration) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      obs.disconnect();
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      gaps.sort((a, b) => a - b);
      return {
        fps: (stamps.length / duration) * 1000,
        worstGapMs: gaps[gaps.length - 1] ?? 0,
        p95GapMs: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((a, b) => a + b, 0),
      };
    }, ms);
    await pinger;
    const after = await this.cost();
    const d = (k: string) =>
      Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
    return {
      ...frames,
      worstRendererPingMs: pingWorst.renderer,
      worstMainPingMs: pingWorst.main,
      scriptMs: d("ScriptDuration"),
      styleMs: d("RecalcStyleDuration"),
      layoutMs: d("LayoutDuration"),
      taskMs: d("TaskDuration"),
      windowMs: ms,
    };
  }

  /** Renderer heap snapshot → per-constructor self size, top N. */
  async heapTop(label: string, top = 25): Promise<void> {
    const file = path.join(path.dirname(OUT), `${label}.heapsnapshot`);
    const chunks: string[] = [];
    const onChunk = (e: { chunk: string }) => chunks.push(e.chunk);
    this.cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await this.cdp.send("HeapProfiler.enable");
    await this.cdp.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });
    this.cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    fs.writeFileSync(file, chunks.join(""));
    record("heap", label, { file, ...summarizeSnapshot(file, top) });
  }

  async detach(): Promise<void> {
    await this.cdp.detach().catch(() => {});
  }
}

function summarizeSnapshot(file: string, top: number): Sample {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const f = snap.snapshot.meta.node_fields as string[];
  const types = snap.snapshot.meta.node_types[0] as string[];
  const stride = f.length;
  const iType = f.indexOf("type");
  const iName = f.indexOf("name");
  const iSize = f.indexOf("self_size");
  const nodes = snap.nodes as number[];
  const strings = snap.strings as string[];
  const by = new Map<string, { size: number; count: number }>();
  let total = 0;
  for (let i = 0; i < nodes.length; i += stride) {
    const type = types[nodes[i + iType]];
    const name =
      type === "object" || type === "native"
        ? strings[nodes[i + iName]]
        : `(${type})`;
    const size = nodes[i + iSize];
    total += size;
    const cur = by.get(name) ?? { size: 0, count: 0 };
    cur.size += size;
    cur.count++;
    by.set(name, cur);
  }
  const rows = [...by.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, top)
    .map(([name, v]) => ({
      name: name.slice(0, 80),
      mb: +(v.size / 1048576).toFixed(2),
      count: v.count,
    }));
  for (const r of rows)
    console.log(`    ${String(r.mb).padStart(8)}MB  ×${r.count}  ${r.name}`);
  return { heapTotalMB: total / 1048576, top: rows };
}

function pssKb(pid: number): number {
  try {
    const m = fs
      .readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
      .match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function daemonRss(tempHome: string): {
  pid: number;
  daemonKb: number;
  childKb: number;
  children: number;
  childPids: number[];
} {
  const manorDir = path.join(tempHome, ".manor");
  let pid: number | null = null;
  try {
    for (const file of fs.readdirSync(manorDir, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (path.basename(file) !== "terminal-host.pid") continue;
      pid = Number(fs.readFileSync(path.join(manorDir, file), "utf8").trim());
      break;
    }
  } catch {
    /* none yet */
  }
  if (!pid)
    return { pid: 0, daemonKb: 0, childKb: 0, children: 0, childPids: [] };
  try {
    const rows = execSync(`ps -o pid=,rss=,comm= -g ${pid}`, {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
    let daemonKb = 0;
    let childKb = 0;
    let children = 0;
    const childPids: number[] = [];
    for (const [p, rss, comm] of rows) {
      // The daemon and its pty helpers are node; shells are the user's.
      if (Number(p) === pid) daemonKb += Number(rss);
      else if (comm === "node" || comm === "electron" || comm === "Electron") {
        childKb += Number(rss);
        children++;
        childPids.push(Number(p));
      }
    }
    return { pid, daemonKb, childKb, children, childPids };
  } catch {
    return { pid, daemonKb: 0, childKb: 0, children: 0, childPids: [] };
  }
}

/** Screenshot and the app's logs, kept beside the samples. */
async function keepEvidence(
  window: Page,
  tempHome: string,
  label: string,
): Promise<void> {
  const dir = path.join(path.dirname(OUT), label);
  fs.mkdirSync(dir, { recursive: true });
  await window
    .screenshot({ path: path.join(dir, "window.png") })
    .catch(() => {});
  const manorDir = path.join(tempHome, ".manor");
  for (const file of fs.readdirSync(manorDir, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!file.endsWith(".log")) continue;
    fs.copyFileSync(
      path.join(manorDir, file),
      path.join(dir, file.replaceAll("/", "__")),
    );
  }
}

async function newTerminal(window: Page, tempHome: string): Promise<string> {
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  return paneId;
}

const overload = process.env.MANOR_PERF_OVERLOAD === "1";

test("scale: many workspaces, each with a terminal", async ({
  app,
  window,
  tempHome,
}) => {
  test.skip(!overload, "set MANOR_PERF_OVERLOAD=1 to run");
  test.setTimeout(900_000);
  await importSeededProject(app, window, tempHome);
  const probe = await Probe.attach(app, window, tempHome);
  await window.waitForTimeout(3_000);
  record("workspaces", "0 (project only)", await probe.sample());

  for (let i = 1; i <= WORKSPACES; i++) {
    const t0 = Date.now();
    await createWorkspace(window, `ws-${i}`);
    await newTerminal(window, tempHome);
    const createMs = Date.now() - t0;
    await window.waitForTimeout(1_500);
    record("workspaces", String(i), { createMs, ...(await probe.sample()) });
  }
  // Idle with N workspaces: what does background polling cost?
  record("workspaces", `idle-${WORKSPACES}`, await probe.watchFrames(15_000));
  record("workspaces", `after-idle`, await probe.sample());
  await probe.heapTop("workspaces");
  await probe.detach();
});

test("flood: several terminals streaming at once", async ({
  app,
  window,
  tempHome,
}) => {
  test.skip(!overload, "set MANOR_PERF_OVERLOAD=1 to run");
  test.setTimeout(900_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "flood");
  const probe = await Probe.attach(app, window, tempHome);
  await newTerminal(window, tempHome);
  await window.waitForTimeout(2_000);
  record("flood", "before", await probe.sample());
  record("flood", "idle-frames", await probe.watchFrames(5_000));

  // Every tab floods; only the last one is on screen. A long, coloured line —
  // what an agent's tool output looks like — as fast as the pty takes it.
  // `zqflood` tags the processes so the stop below kills only these.
  const line =
    "$'\\e[32m✓\\e[0m \\e[1mtool_result\\e[0m src/components/SomethingLong.tsx:123 \\e[33mwarning\\e[0m lorem ipsum zqflood'";
  for (let i = 0; i < FLOOD_TABS; i++) {
    if (i > 0) await newTerminal(window, tempHome);
    await runInTerminal(window, `yes ${line}`);
    await window.waitForTimeout(500);
  }
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < FLOOD_SECONDS * 1000) {
    const t = Math.round((Date.now() - start) / 1000);
    record("flood", `t+${t}s frames`, await probe.watchFrames(4_000));
    record("flood", `t+${t}s mem`, await probe.sample(n++ % 3 === 0));
    if (n === 1) await keepEvidence(window, tempHome, "flood-t0");
  }
  // `zq[f]lood` so the pattern never matches this pkill's own shell.
  execSync("pkill -f 'zq[f]lood' || true");
  await window.waitForTimeout(5_000);
  record("flood", "after-stop", await probe.sample());
  await window.waitForTimeout(20_000);
  record("flood", "after-stop+20s", await probe.sample());
  record("flood", "settled-frames", await probe.watchFrames(5_000));
  await probe.heapTop("flood");

  // Typing latency after the storm: one key into the visible pane, timed
  // until xterm's buffer shows it.
  const paneId = await activePaneId(window);
  const t0 = Date.now();
  await window.keyboard.type("echo zq-latency-mark");
  await expect
    .poll(
      () =>
        window.evaluate((id) => {
          const t = window.__manorTerminals?.get(id)?.term;
          if (!t) return false;
          const b = t.buffer.active;
          for (let y = Math.max(0, b.length - 5); y < b.length; y++) {
            if (b.getLine(y)?.translateToString().includes("zq-latency-mark"))
              return true;
          }
          return false;
        }, paneId),
      { timeout: 30_000, intervals: [10] },
    )
    .toBe(true);
  record("flood", "echo-latency", { echoMs: Date.now() - t0 });
  await probe.detach();
});

test("diff: ramp a worktree's diff until the pane gives out", async ({
  app,
  window,
  tempHome,
}) => {
  test.skip(!overload, "set MANOR_PERF_OVERLOAD=1 to run");
  test.setTimeout(1_200_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "diff-ramp");
  const worktree = await waitForWorktree(tempHome);
  const probe = await Probe.attach(app, window, tempHome);

  // Commit a baseline the size of the biggest step, so every step is a
  // rewrite of tracked files (a real modification diff, not untracked files).
  const FILES = 40;
  const maxLines = Math.max(...DIFF_STEPS);
  const perFile = Math.ceil(maxLines / FILES);
  for (let f = 0; f < FILES; f++) {
    fs.writeFileSync(
      path.join(worktree, `mod-${f}.ts`),
      body(f, "base", perFile),
    );
  }
  git(worktree, "add -A");
  git(worktree, 'commit -qm "baseline"');

  await window.keyboard.press("ControlOrMeta+Shift+g");
  await expect(window.locator("[data-diff-lines], [data-testid*=diff]").first())
    .toBeVisible({
      timeout: 60_000,
    })
    .catch(() => {});
  await window.waitForTimeout(3_000);
  record("diff", "0 lines", await probe.sample());

  for (const total of DIFF_STEPS) {
    // Change `total` lines spread across the files.
    const changedPerFile = Math.ceil(total / FILES);
    const diffBytes = (() => {
      for (let f = 0; f < FILES; f++) {
        fs.writeFileSync(
          path.join(worktree, `mod-${f}.ts`),
          body(f, "base", perFile, changedPerFile, `step${total}`),
        );
      }
      return execSync("git diff | wc -c", {
        cwd: worktree,
        encoding: "utf8",
      }).trim();
    })();
    const t0 = Date.now();
    // Wait until the pane shows this step's text, or give up.
    let shownMs: number | null = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const hit = await window
        .evaluate(
          (mark) =>
            Array.from(document.querySelectorAll("[data-diff-lines]")).some(
              (el) => el.textContent?.includes(mark),
            ),
          `step${total}-`,
        )
        .catch(() => false);
      if (hit) {
        shownMs = Date.now() - t0;
        break;
      }
      await window.waitForTimeout(250);
    }
    record("diff", `${total} lines`, {
      changedLines: total,
      diffBytes: Number(diffBytes),
      shownMs,
      ...(await probe.sample()),
    });
    record("diff", `${total} lines idle`, await probe.watchFrames(12_000));
    // Scroll through it: the virtualizer's real job.
    const scroll = await scrollDiff(window, probe);
    record("diff", `${total} lines scroll`, scroll);
    if (shownMs === null) break;
  }
  await probe.heapTop("diff");
  await probe.detach();
});

async function scrollDiff(window: Page, probe: Probe): Promise<Sample> {
  const watch = probe.watchFrames(4_000);
  await window.evaluate(async () => {
    const scroller = Array.from(
      document.querySelectorAll<HTMLElement>("*"),
    ).find(
      (el) =>
        el.scrollHeight > el.clientHeight + 500 &&
        getComputedStyle(el).overflowY.match(/auto|scroll/) &&
        el.querySelector("[data-diff-lines]"),
    );
    if (!scroller) return;
    const end = performance.now() + 3_500;
    while (performance.now() < end) {
      scroller.scrollTop += 600;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  return watch;
}

function body(
  file: number,
  gen: string,
  lines: number,
  changed = 0,
  changedGen = "",
): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const g = i < changed ? changedGen : gen;
    out.push(
      `export const value_${file}_${i} = { id: ${i}, name: "${g}-${file}-${i}", enabled: ${i % 3 === 0}, tags: ["a", "b"] };`,
    );
  }
  return out.join("\n") + "\n";
}

async function waitForWorktree(tempHome: string): Promise<string> {
  const root = path.join(tempHome, ".manor", "worktrees");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(root)) {
      for (const project of fs.readdirSync(root)) {
        for (const ws of fs.readdirSync(path.join(root, project))) {
          const dir = path.join(root, project, ws);
          if (fs.existsSync(path.join(dir, ".git"))) return dir;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no worktree under ${root}`);
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Manor E2E",
      GIT_AUTHOR_EMAIL: "test@manor-e2e.local",
      GIT_COMMITTER_NAME: "Manor E2E",
      GIT_COMMITTER_EMAIL: "test@manor-e2e.local",
    },
  });
}

/**
 * The back-to-top button used to be inserted into the pane's sticky dock when
 * the diff scrolled past 300px. The dock sits in the scroller's flow, so that
 * insertion restyled and relaid out every row: seconds on a 2,000-line diff.
 * It now stays mounted and only toggles visibility. Crossing the threshold
 * either way has to stay cheap, and the button has to still work.
 */
test("diff: crossing the back-to-top threshold costs nothing", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(600_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "diff-scroll");
  const worktree = await waitForWorktree(tempHome);
  const FILES = 40;
  for (let f = 0; f < FILES; f++) {
    fs.writeFileSync(path.join(worktree, `mod-${f}.ts`), body(f, "base", 500));
  }
  git(worktree, "add -A");
  git(worktree, 'commit -qm "baseline"');
  for (let f = 0; f < FILES; f++) {
    fs.writeFileSync(
      path.join(worktree, `mod-${f}.ts`),
      body(f, "base", 500, 50, "changed"),
    );
  }
  await window.keyboard.press("ControlOrMeta+Shift+g");
  await expect
    .poll(() => window.locator("[data-diff-lines] [data-index]").count(), {
      timeout: 90_000,
    })
    .toBeGreaterThan(3000);
  await window.waitForTimeout(3_000);

  const backToTop = window.getByRole("button", { name: "Back to top" });
  await expect(backToTop).toBeHidden();

  const probe = await Probe.attach(app, window, tempHome);
  // Highlighting lands after the rows mount, and restyles them as it does.
  // Measure the scroll, not that: wait for a second with no style work.
  for (let i = 0; i < 60; i++) {
    const before = await probe.cost();
    await window.waitForTimeout(1_000);
    const after = await probe.cost();
    const styleMs =
      ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) *
      1000;
    if (styleMs < 20) break;
  }
  const scrollTo = async (top: number) => {
    const before = await probe.cost();
    await window.evaluate(async (y) => {
      const scroller = Array.from(
        document.querySelectorAll<HTMLElement>("*"),
      ).find(
        (el) =>
          el.scrollHeight > el.clientHeight + 500 &&
          /auto|scroll/.test(getComputedStyle(el).overflowY) &&
          el.querySelector("[data-diff-lines]"),
      );
      if (scroller) scroller.scrollTop = y;
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    }, top);
    const after = await probe.cost();
    const d = (k: string) =>
      Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
    const cost = {
      styleMs: d("RecalcStyleDuration"),
      layoutMs: d("LayoutDuration"),
    };
    record("diff-scroll", `scrollTop=${top}`, cost);
    return cost;
  };

  for (const top of [100, 400, 5000, 100]) {
    const { styleMs, layoutMs } = await scrollTo(top);
    // Was 1.8–4.8s at the threshold crossings. Loose: a slow box is not a bug.
    expect(styleMs + layoutMs, `scrolling to ${top}`).toBeLessThan(500);
  }

  await scrollTo(5000);
  await expect(backToTop).toBeVisible();
  await window.screenshot({
    path: path.join(path.dirname(OUT), "back-to-top.png"),
  });
  await backToTop.click();
  await expect(backToTop).toBeHidden({ timeout: 5_000 });
  await probe.detach();
});
