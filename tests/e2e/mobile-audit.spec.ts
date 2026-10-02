import fs from "fs";
import path from "path";
import {
  chromium,
  devices,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  createWorkspace,
  expect,
  importSeededProject,
  openTerminalTab,
  test as base,
} from "./fixtures";
import { startLatencyProxy } from "./helpers/latency-proxy";
import {
  AuditReport,
  BRIDGE_TRACE_SCRIPT,
  bridgeCalls,
  PERF_INIT_SCRIPT,
  PHONE_PROFILE,
  pct,
  perfSnapshot,
  resourceSummary,
  setCpuThrottle,
  terminalGeometry,
  throttle,
  timed,
} from "./helpers/mobile-audit";
import {
  seedRelayState,
  startLocalRelay,
  type LocalRelay,
} from "./helpers/relay";
import {
  closeSettings,
  enableRemoteControl,
  pairDeviceViaRelay,
  startRelay,
} from "./helpers/settings";
import { activePaneId, awaitShellReady } from "./helpers/terminal";

/**
 * The phone, end to end, as a phone gets it: the desktop paired through a
 * local relay (`wrangler dev`, as `relay.spec.ts` runs it), the link opened
 * in a touch-emulating Chromium at an iPhone's size, with a mid-tier CPU and
 * Fast-4G network throttle. It walks every phone surface — cold load, the
 * terminal, the drawer, a workspace switch, the pane switcher, tabs, the
 * palette, Settings, typing, an output flood, landscape and the small and
 * large phone sizes — and for each one records geometry defects (overflow,
 * tap targets, iOS input zoom, tiny or clipped text), axe violations,
 * screenshots and timings into `test-results/mobile-audit/`.
 *
 * The budgets at the end are the regression guard: they hold what the
 * phone experience has been tightened to.
 *
 * `pnpm test:e2e:mobile` builds first; `pnpm e2e:mobile` does not.
 * Needs Node >= 22 on PATH (wrangler), like the relay suite.
 */

const PHONE = devices["iPhone 13"];
const OUT = path.join(__dirname, "../../test-results/mobile-audit");

const test = base.extend<{ relay: LocalRelay }, { relaySeed: string }>({
  relaySeed: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const seed = await seedRelayState();
      try {
        await use(seed);
      } finally {
        fs.rmSync(seed, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  relay: [
    async ({ relaySeed }, use) => {
      const relay = await startLocalRelay(relaySeed);
      try {
        await use(relay);
      } finally {
        await relay.dispose();
      }
    },
    { timeout: 120_000 },
  ],
  appLaunch: async ({ relay }, use) => {
    await use({ env: { MANOR_RELAY_URL: relay.url }, asPackage: true });
  },
});

interface Phone {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  log: string[];
  frames: { t: number; dir: "up" | "down"; bytes: number }[];
}

async function openPhone(link: string): Promise<Phone> {
  const browser = await chromium.launch({
    headless: process.env.MANOR_E2E_HEADED !== "1",
    // Emulated `deviceScaleFactor` alone does not reach ResizeObserver's
    // device-pixel-content-box, which xterm's WebGL renderer sizes its
    // canvas from: it would draw a 3× scene into a 1× buffer. A real phone
    // agrees with itself, so make the browser's own scale match.
    args: [`--force-device-scale-factor=${PHONE.deviceScaleFactor}`],
  });
  const context = await browser.newContext({
    // Chromium can't be WebKit; keep the iPhone's size, density and touch.
    viewport: PHONE.viewport,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE.userAgent,
  });
  await context.addInitScript(PERF_INIT_SCRIPT);
  await context.addInitScript(BRIDGE_TRACE_SCRIPT);
  const page = await context.newPage();
  const log: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      log.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) =>
    log.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`),
  );
  const cdp = await throttle(page);
  // Every WebSocket frame of the cold load, for counting the round trips a
  // phone pays before it can show anything.
  const frames: { t: number; dir: "up" | "down"; bytes: number }[] = [];
  cdp.on("Network.webSocketFrameSent", (e) =>
    frames.push({ t: e.timestamp, dir: "up", bytes: e.response.payloadData.length }),
  );
  cdp.on("Network.webSocketFrameReceived", (e) =>
    frames.push({ t: e.timestamp, dir: "down", bytes: e.response.payloadData.length }),
  );
  // MANOR_AUDIT_PROFILE=1: a CPU profile of the cold load, for finding what
  // the first seconds are spent on (open it in DevTools' Performance tab).
  if (process.env.MANOR_AUDIT_PROFILE === "1") {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await page.goto(link);
  return { browser, page, cdp, log, frames };
}

/** Wait until a pane's grid shows `text`. */
async function waitForText(page: Page, paneId: string, text: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ id }) => {
            const h = window.__manorTerminals?.get(id);
            if (!h) return "";
            const b = h.term.buffer.active;
            const lines: string[] = [];
            for (let i = 0; i < b.length; i++)
              lines.push(b.getLine(i)?.translateToString(true) ?? "");
            return lines.join("\n");
          },
          { id: paneId },
        ),
      { timeout: 30_000 },
    )
    .toContain(text);
}

/**
 * Keystroke-to-echo through the whole road: xterm's input → bridge →
 * relay → host pty → shell echo → relay → xterm parse. Measured in the page
 * from the moment the key is handed to xterm to the write that puts it on
 * the cursor line.
 */
async function echoLatency(page: Page, paneId: string, ch: string, expectLine: string) {
  return page.evaluate(
    ({ id, ch, expectLine }) =>
      new Promise<number>((resolve, reject) => {
        const term = window.__manorTerminals!.get(id)!.term;
        const t0 = performance.now();
        const cursorLine = () => {
          const b = term.buffer.active;
          const out: string[] = [];
          for (let i = Math.max(0, b.baseY + b.cursorY - 4); i <= b.baseY + b.cursorY; i++)
            out.push(b.getLine(i)?.translateToString(true) ?? "");
          return `${out.join("⏎")} @${b.cursorX},${b.cursorY} cols ${term.cols}`;
        };
        const timer = setTimeout(
          () => reject(new Error(`echo timeout: cursor line ${JSON.stringify(cursorLine())}`)),
          10_000,
        );
        const sub = term.onWriteParsed(() => {
          // The prompt may wrap, so read the logical line the cursor is on.
          const b = term.buffer.active;
          let row = b.baseY + b.cursorY;
          let line = b.getLine(row)?.translateToString(true) ?? "";
          while (row > 0 && b.getLine(row)?.isWrapped) {
            row--;
            line = (b.getLine(row)?.translateToString(true) ?? "") + line;
          }
          if (line.includes(expectLine)) {
            clearTimeout(timer);
            sub.dispose();
            resolve(performance.now() - t0);
          }
        });
        term.input(ch, true);
      }),
    { id: paneId, ch, expectLine },
  );
}

const W1 = "audit-primary";
const W2 = "audit-a-workspace-with-a-rather-long-name";

const tabs = (page: Page) => page.locator('[data-testid="tab"]:visible');

test("phone audit: every phone surface over the relay, throttled", async ({
  app,
  window,
  tempHome,
  relay,
}) => {
  test.setTimeout(600_000);
  const report = new AuditReport(OUT);

  // ── The desk: two workspaces, a split, two tabs. ─────────────────────
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, W2);
  await openTerminalTab(window);
  const paneW2 = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneW2);

  await createWorkspace(window, W1);
  await openTerminalTab(window);
  const paneA = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneA);
  await window.keyboard.press("ControlOrMeta+d");
  await expect(
    window.locator('[data-testid="workspace-pane"]:visible'),
  ).toHaveCount(2);
  await window.keyboard.press("ControlOrMeta+t");
  await expect(tabs(window)).toHaveCount(2);
  await tabs(window).first().click();

  await enableRemoteControl(window);
  await startRelay(window);
  const device = await pairDeviceViaRelay(window, { label: "audit phone" });
  await closeSettings(window);

  // ── Cold load ────────────────────────────────────────────────────────
  // The phone reaches the relay through a round trip's worth of delay; the
  // desk, like a desk on a wired network, does not.
  const proxy = await startLatencyProxy(relay.url, PHONE_PROFILE.rttMs);
  const phoneLink = new URL(device.link);
  phoneLink.host = new URL(proxy.url).host;
  const phone = await openPhone(phoneLink.toString());
  const { page, cdp } = phone;
  try {
    const topBar = page.getByTestId("phone-top-bar");
    await expect(topBar).toBeVisible({ timeout: 90_000 });
    const shell = await page.evaluate(() => performance.now());
    report.data.wsFramesBeforeTopBar = phone.frames.length;
    const pane = page.locator('[data-testid="terminal-pane"]:visible').first();
    await expect(pane.locator(".xterm-screen")).toBeVisible({ timeout: 60_000 });
    const paneId = await activePaneId(page);
    await waitForText(page, paneId, "$");
    {
      // Sequential round trips: an upstream frame sent only after a
      // downstream one arrived, i.e. a call that waited on an answer.
      const f = phone.frames;
      const t0 = f[0]?.t ?? 0;
      report.data.wsColdTimeline = f.slice(0, 80).map(
        (x) => `${Math.round((x.t - t0) * 1000)}ms ${x.dir} ${x.bytes}B`,
      );
      report.data.wsFramesBeforePrompt = f.length;
      const calls = await bridgeCalls(page);
      report.data.bridgeColdCalls = calls
        .filter((c) => c.start < shell + 1000)
        .map((c) => `${Math.round(c.start)}→${c.end === null ? "…" : Math.round(c.end)} ${c.name}`);
    }
    if (process.env.MANOR_AUDIT_PROFILE === "1") {
      const { profile } = await cdp.send("Profiler.stop");
      fs.writeFileSync(path.join(OUT, "cold-load.cpuprofile"), JSON.stringify(profile));
    }
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return { ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd };
    });
    report.time("cold: ttfb", nav.ttfb);
    report.time("cold: DOMContentLoaded", nav.domContentLoaded);
    report.time("cold: load", nav.load);
    await expect
      .poll(async () => Object.keys((await perfSnapshot(page)).marks).length)
      .toBe(4);
    const perf0 = await perfSnapshot(page);
    report.time("cold: app shell on screen", perf0.marks.app);
    report.time("cold: top bar on screen", perf0.marks.topBar);
    report.time("cold: terminal on screen", perf0.marks.terminal);
    report.time("cold: prompt on screen", perf0.marks.prompt);
    report.time("cold: first contentful paint", perf0.paints["first-contentful-paint"] ?? -1);
    report.time("cold: LCP", perf0.lcp);
    report.data.coldLongTasks = {
      count: perf0.longTasks.length,
      totalMs: Math.round(perf0.longTasks.reduce((a, t) => a + t.duration, 0)),
      worstMs: Math.round(Math.max(0, ...perf0.longTasks.map((t) => t.duration))),
    };
    report.data.coldCLS = Math.round(perf0.shifts.reduce((a, s) => a + s.value, 0) * 1000) / 1000;
    report.data.coldResources = await resourceSummary(page);
    const metrics = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.metrics.map((x) => [x.name, x.value]));
    report.data.coldHeapMB = Math.round((m.JSHeapUsedSize ?? 0) / 1e5) / 10;
    report.data.coldDomNodes = m.Nodes;
    report.data.terminals = await page.evaluate(() => ({
      mounted: window.__manorTerminals?.size ?? 0,
      webglCanvases: Array.from(document.querySelectorAll(".xterm canvas")).filter(
        (c) => !!(c as HTMLCanvasElement).getContext("webgl2"),
      ).length,
    }));
    await page.waitForTimeout(1500);

    // Geometry and axe run unthrottled: they measure layout, not speed.
    await setCpuThrottle(cdp, false);
    await report.screen(page, "terminal");
    await setCpuThrottle(cdp, true);

    // ── Typing: keystroke to echo through the relay ───────────────────
    const typed = "echoaudit";
    for (let i = 0; i < typed.length; i++) {
      report.time(
        "keystroke → echo",
        await echoLatency(page, paneId, typed[i], typed.slice(0, i + 1)),
      );
    }
    await page.evaluate((id) => window.__manorTerminals!.get(id)!.term.input("\r", true), paneId);

    // A tap on the terminal must focus xterm so the soft keyboard opens.
    await pane.tap();
    const focused = await page.evaluate(
      () => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false,
    );
    report.data.tapFocusesTerminal = focused;

    // ── Fit to screen: the phone takes the winsize, the desk takes it back ─
    const fit = pane.getByTestId("terminal-follower");
    await expect(fit).toBeVisible();
    const deskCols = (await terminalGeometry(page))[0].cols;
    report.time(
      "tap → fit to screen",
      await timed(
        page,
        () => fit.tap(),
        () =>
          !Array.from(document.querySelectorAll('[data-testid="terminal-follower"]')).some((b) =>
            (b as HTMLElement).checkVisibility({ visibilityProperty: true }),
          ),
      ),
    );
    await expect
      .poll(async () => (await terminalGeometry(page))[0].cols)
      .toBeLessThan(deskCols);
    const fitted = (await terminalGeometry(page))[0];
    report.data.fittedGrid = `${fitted.cols}×${fitted.rows} @ ${fitted.fontSize}px`;
    // The desk follows the phone now…
    const deskPane = window.locator('[data-testid="terminal-pane"]:visible', {
      has: window.getByTestId("terminal-follower"),
    });
    await expect(deskPane).toHaveCount(1);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "fitted");
    await setCpuThrottle(cdp, true);
    // …until someone types at the desk.
    await deskPane.click();
    await window.keyboard.type(" ");
    await expect(fit).toBeVisible();
    await window.keyboard.press("Backspace");

    // ── Output flood: what a busy agent does to the phone ─────────────
    const before = (await perfSnapshot(page)).longTasks.length;
    const floodStart = await page.evaluate(() => performance.now());
    await page.evaluate(
      (id) => window.__manorTerminals!.get(id)!.term.input("seq 1 30000; echo flood-done\r", true),
      paneId,
    );
    await waitForText(page, paneId, "flood-done");
    report.time("flood: 30k lines rendered", (await page.evaluate(() => performance.now())) - floodStart);
    const flood = (await perfSnapshot(page)).longTasks.slice(before);
    report.data.floodLongTasks = {
      count: flood.length,
      totalMs: Math.round(flood.reduce((a, t) => a + t.duration, 0)),
      worstMs: Math.round(Math.max(0, ...flood.map((t) => t.duration))),
    };

    // ── Drawer ───────────────────────────────────────────────────────
    const drawer = page.getByTestId("sidebar-drawer");
    report.time(
      "tap → drawer open",
      await timed(page, () => page.getByTestId("phone-drawer-toggle").tap(), () => !!document.querySelector('[data-testid="sidebar-drawer"]')),
    );
    await page.waitForTimeout(400);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "drawer");
    await setCpuThrottle(cdp, true);

    // ── Workspace switch from the drawer ─────────────────────────────
    report.time(
      "tap → workspace switched",
      await timed(
        page,
        () => drawer.getByTestId("workspace-item").filter({ hasText: W2 }).tap(),
        (name: string) =>
          (document.querySelector('[data-testid="phone-top-bar"]')?.textContent ?? "").includes(name),
        W2.slice(0, 10),
      ),
    );
    await page.waitForTimeout(400);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "long-workspace-name");
    await setCpuThrottle(cdp, true);
    await page.getByTestId("phone-drawer-toggle").tap();
    await drawer.getByTestId("workspace-item").filter({ hasText: W1 }).tap();
    await expect(drawer).toBeHidden();

    // ── Pane switcher ────────────────────────────────────────────────
    const sheet = page.getByTestId("pane-switcher");
    report.time(
      "tap → pane switcher open",
      await timed(page, () => page.getByTestId("phone-pane-switcher-button").tap(), () => !!document.querySelector('[data-testid="pane-switcher"]')),
    );
    await page.waitForTimeout(400);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "pane-switcher");
    await setCpuThrottle(cdp, true);
    const other = sheet.locator('[data-testid="pane-switcher-row"]:not([aria-current="true"])').first();
    const targetPaneId = (await other.getAttribute("data-pane-id"))!;
    report.time(
      "tap → pane switched",
      await timed(
        page,
        () => other.tap(),
        (id: string) =>
          !document.querySelector('[data-testid="pane-switcher"]') &&
          window.__manorTerminals?.get(id)?.term.element?.checkVisibility({ visibilityProperty: true }) === true,
        targetPaneId,
      ),
    );

    // ── Tabs ─────────────────────────────────────────────────────────
    report.time(
      "tap → tab switched",
      await timed(
        page,
        () => tabs(page).nth(1).tap(),
        () => Array.from(document.querySelectorAll('[data-testid="tab"]')).filter((t) => (t as HTMLElement).checkVisibility({ visibilityProperty: true }))[1]?.getAttribute("aria-selected") === "true",
      ),
    );

    // ── Palette ──────────────────────────────────────────────────────
    const palette = page.getByTestId("command-palette");
    report.time(
      "tap → palette open",
      await timed(page, () => page.getByTestId("phone-palette-button").tap(), () => !!document.querySelector('[data-testid="command-palette"] [cmdk-item]')),
    );
    await page.waitForTimeout(400);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "palette");
    await setCpuThrottle(cdp, true);
    const input = palette.locator("[cmdk-input]");
    for (const ch of "settings") {
      report.time(
        "palette keystroke → results",
        await timed(
          page,
          () => input.press(ch),
          (typed: string) =>
            (document.querySelector("[cmdk-input]") as HTMLInputElement | null)?.value.endsWith(typed) === true,
          ch,
        ),
      );
    }
    await setCpuThrottle(cdp, false);
    await report.screen(page, "palette-search");
    await setCpuThrottle(cdp, true);

    // ── Settings ─────────────────────────────────────────────────────
    const settings = page.getByTestId("settings-modal");
    report.time(
      "palette → settings open",
      await timed(
        page,
        () => palette.locator("[cmdk-item]", { hasText: "Settings: General" }).first().tap(),
        () => !!document.querySelector('[data-testid="settings-modal"]'),
      ),
    );
    await page.waitForTimeout(400);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "settings");
    await setCpuThrottle(cdp, true);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // ── Sizes and orientation (layout only) ─────────────────────────
    await setCpuThrottle(cdp, false);
    for (const [name, size] of [
      ["small-phone", { width: 320, height: 568 }],
      ["large-phone", { width: 430, height: 932 }],
      ["landscape", { width: 844, height: 390 }],
      ["tablet-portrait", { width: 744, height: 1133 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(600);
      await report.screen(page, name, { axe: false });
    }
    await page.setViewportSize(PHONE.viewport);
    await page.waitForTimeout(400);
    await page.getByTestId("phone-drawer-toggle").tap();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(400);
    await report.screen(page, "small-phone-drawer", { axe: false });
    await page.keyboard.press("Escape");

    report.data.consoleErrors = phone.log.slice(0, 40);
    report.data.final = await page.evaluate(() => ({
      domNodes: document.getElementsByTagName("*").length,
    }));
  } finally {
    report.data.consoleErrors ??= phone.log.slice(0, 40);
    await page.screenshot({ path: path.join(OUT, "last.png") }).catch(() => {});
    const md = report.write();
    console.log(md);
    await test.info().attach("phone-audit.md", { body: md, contentType: "text/markdown" });
    await phone.browser.close();
    await proxy.close();
  }
});

/** Silence an unused import if a budget section is not yet written. */
void pct;
