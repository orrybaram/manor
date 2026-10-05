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
  FAKE_KEYBOARD_SCRIPT,
  PERF_INIT_SCRIPT,
  PHONE_PROFILE,
  pct,
  perfSnapshot,
  resourceSummary,
  type ResourceSummary,
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
  pairBrowser,
} from "./helpers/settings";
import { activePaneId, awaitShellReady } from "./helpers/terminal";

/**
 * The phone, end to end, as a phone gets it: the desktop paired through a
 * local relay (`wrangler dev`, as `relay.spec.ts` runs it), the link opened
 * in a touch-emulating Chromium at an iPhone's size, with a mid-tier CPU and
 * Fast-4G network throttle. It walks every phone surface — cold load, the
 * terminal, the drawer, a workspace switch, the next pane, tabs, the
 * palette, Settings, typing, an output flood, landscape and the small and
 * large phone sizes — and for each one records geometry defects (overflow,
 * tap targets, iOS input zoom, tiny or clipped text), axe violations,
 * screenshots and timings into `tests/e2e/artifacts/mobile-audit/`.
 *
 * The budgets at the end are the regression guard: they hold what the
 * phone experience has been tightened to.
 *
 * `pnpm test:e2e:mobile` builds first; `pnpm e2e:mobile` does not.
 * Needs Node >= 22 on PATH (wrangler), like the relay suite.
 */

const PHONE = devices["iPhone 13"];
// Beside the filmstrips, not under test-results/: every Playwright run
// empties that, so the next unrelated run would delete the report.
const OUT = path.join(__dirname, "artifacts/mobile-audit");

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
  await context.addInitScript(FAKE_KEYBOARD_SCRIPT);
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
            // Logical lines: a row the terminal wrapped joins the one before.
            const b = h.term.buffer.active;
            let text = "";
            for (let i = 0; i < b.length; i++) {
              const line = b.getLine(i);
              text += (i > 0 && !line?.isWrapped ? "\n" : "") + (line?.translateToString(true) ?? "");
            }
            return text;
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

// A tap that cannot happen should fail saying why, not hold the test for
// its whole budget.
test.use({ actionTimeout: 15_000 });

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

  const device = await pairBrowser(window, { label: "audit phone" });
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
    // With the grid filling the pane, the soft keyboard covers its bottom
    // rows. It lifts the shell, without resizing the pane, until the
    // cursor's row clears it.
    await pane.tap();
    const keyboardPx = 300;
    const setKeyboard = (px: number) =>
      page.evaluate((px) => (window as unknown as { __setKeyboard(px: number): void }).__setKeyboard(px), px);
    const cursorBottom = () =>
      page.evaluate((id) => {
        const term = window.__manorTerminals!.get(id)!.term;
        const rect = term.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
        const buf = term.buffer.active;
        const row = buf.cursorY + buf.baseY - buf.viewportY;
        return rect.top + ((row + 1) * rect.height) / term.rows;
      }, paneId);
    const rowsBefore = (await terminalGeometry(page))[0].rows;
    // Push the prompt to the pane's last row, under where the keyboard goes.
    await page.evaluate((id) => window.__manorTerminals!.get(id)!.term.input("clear; for i in $(seq 200); do echo; done\r", true), paneId);
    await expect.poll(cursorBottom).toBeGreaterThan(PHONE.viewport.height - keyboardPx);
    await setKeyboard(keyboardPx);
    await expect
      .poll(cursorBottom)
      .toBeLessThanOrEqual(PHONE.viewport.height - keyboardPx + 1);
    expect((await terminalGeometry(page))[0].rows).toBe(rowsBefore);
    await setCpuThrottle(cdp, false);
    await report.screen(page, "keyboard");
    await setCpuThrottle(cdp, true);
    await setKeyboard(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--phone-keyboard-shift")))
      .toBe("");

    // …until someone types at the desk.
    await deskPane.click();
    await window.keyboard.type(" ");
    await expect(fit).toBeVisible();
    await window.keyboard.press("Backspace");

    // ── The network drops: back to a live terminal on its own ─────────
    {
      const marker = "back-after-drop";
      const t0 = Date.now();
      proxy.dropAll();
      // Typed into a dead line: it must still arrive once the line is back
      // — or at least, typing again after reconnecting must work.
      await expect
        .poll(
          async () => {
            await page.evaluate(
              ({ id, m }) => window.__manorTerminals!.get(id)!.term.input(`echo ${m}\r`, true),
              { id: paneId, m: marker },
            );
            await page.waitForTimeout(1_000);
            return page.evaluate(
              ({ id, m }) => {
                const b = window.__manorTerminals!.get(id)!.term.buffer.active;
                for (let i = 0; i < b.length; i++) {
                  if (b.getLine(i)?.translateToString(true) === m) return true;
                }
                return false;
              },
              { id: paneId, m: marker },
            );
          },
          { timeout: 30_000, intervals: [0] },
        )
        .toBe(true);
      report.time("network drop → terminal live again", Date.now() - t0);
      // A long dead spell (a subway ride): the redial backoff grows while
      // nothing answers. When the network is back, the page hears `online`
      // and must not sit out the rest of a 16–30s wait.
      proxy.outage();
      await page.waitForTimeout(20_000);
      proxy.restore();
      const t1 = Date.now();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.getByTestId("web-app-unreachable")).toBeHidden({ timeout: 30_000 });
      const marker2 = "back-after-outage";
      await page.evaluate(
        ({ id, m }) => window.__manorTerminals!.get(id)!.term.input(`echo ${m}\r`, true),
        { id: paneId, m: marker2 },
      );
      await waitForText(page, paneId, `\n${marker2}`);
      report.time("long outage → terminal live again", Date.now() - t1);

      report.data.unreachableShownOnDrop = await page
        .getByTestId("web-app-unreachable")
        .isVisible()
        .catch(() => false);
    }

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

    // ── Swipe the drawer closed ──────────────────────────────────────
    // A finger dragged left across the sheet: CDP touch events, since
    // Playwright's touchscreen only taps. Timed from the finger lifting.
    const box = (await drawer.boundingBox())!;
    const y = box.y + box.height / 2;
    const fromX = box.x + box.width - 40;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: fromX, y }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: fromX - i * 25, y }],
      });
    }
    report.time(
      "swipe → drawer closed",
      await timed(
        page,
        async () => {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        },
        () => !document.querySelector('[data-testid="sidebar-drawer"]'),
      ),
    );
    await page.getByTestId("phone-drawer-toggle").tap();
    await expect(drawer).toBeVisible();

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

    // ── Next pane, from the palette ──────────────────────────────────
    const paneBefore = await activePaneId(page);
    await page.getByTestId("phone-palette-button").tap();
    const paletteInput = page.getByTestId("command-palette").locator("[cmdk-input]");
    await paletteInput.fill("Next Pane");
    report.time(
      "palette → pane switched",
      await timed(
        page,
        () =>
          page
            .getByTestId("command-palette")
            .locator("[cmdk-item]", { hasText: "Next Pane" })
            .first()
            .tap(),
        (before: string) =>
          !document.querySelector('[data-testid="command-palette"]') &&
          Array.from(window.__manorTerminals ?? []).some(
            ([id, h]) =>
              id !== before &&
              h.term.element?.checkVisibility({ visibilityProperty: true }) === true,
          ),
        paneBefore,
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

    // ── The views a phone opens from the drawer and the palette ──────
    const fromDrawer = async (testId: string) => {
      await page.getByTestId("phone-drawer-toggle").tap();
      await expect(drawer).toBeVisible();
      await drawer.getByTestId(testId).tap();
      await expect(drawer).toBeHidden();
    };
    const fromPalette = async (label: string) => {
      await page.getByTestId("phone-palette-button").tap();
      await expect(palette).toBeVisible();
      await palette.locator("[cmdk-input]").fill(label);
      await palette.locator("[cmdk-item]", { hasText: label }).first().tap();
    };
    const screenSettled = async (name: string) => {
      await page.waitForTimeout(500);
      await setCpuThrottle(cdp, false);
      await report.screen(page, name);
      await setCpuThrottle(cdp, true);
    };

    await fromDrawer("home-row");
    await expect(page.getByTestId("home-view")).toBeVisible();
    await screenSettled("dashboard");

    await fromDrawer("tasks-row");
    await expect(page.getByTestId("tasks-view")).toBeVisible();
    await screenSettled("tasks");

    await fromPalette("View All Agents");
    await page.waitForTimeout(800);
    await screenSettled("agents");
    await page.keyboard.press("Escape");

    // Full screen, with no overlay to tap: the X button is the way out.
    await page.getByTestId("phone-palette-button").tap();
    await expect(palette).toBeVisible();
    await palette.getByTestId("command-palette-close").tap();
    await expect(palette).toBeHidden();

    await fromPalette("New Workspace");
    await expect(page.getByTestId("new-workspace-dialog")).toBeVisible();
    await screenSettled("new-workspace");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-workspace-dialog")).toBeHidden();

    await page.getByTestId("phone-drawer-toggle").tap();
    await drawer.getByTestId("workspace-item").filter({ hasText: W1 }).tap();
    await expect(drawer).toBeHidden();

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

    checkBudgets(report, phone.log);
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


test("a phone that drops a chunk on a bad connection recovers, not a blank page", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(240_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, W1);
  await openTerminalTab(window);
  const device = await pairBrowser(window, { label: "flaky phone" });
  await closeSettings(window);

  const browser = await chromium.launch({ headless: process.env.MANOR_E2E_HEADED !== "1" });
  try {
    const context = await browser.newContext({
      viewport: PHONE.viewport,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // The connection drops the app's own chunk, CSS and JS, the first time
    // each is asked for — what a phone walking out of wifi does mid-load.
    const dropped = new Set<string>();
    await page.route(/\/assets\/App-[^/]+\.(css|js)$/, (route) => {
      const kind = route.request().url().endsWith(".css") ? "css" : "js";
      if (dropped.has(kind)) return route.continue();
      dropped.add(kind);
      return route.abort("connectionreset");
    });
    await page.goto(device.link);
    const recovered = page
      .getByTestId("phone-top-bar")
      .or(page.getByTestId("web-app-load-failed"));
    await expect(recovered).toBeVisible({ timeout: 60_000 });
    // A reload is the better answer, but a screen with a Reload button is
    // still not a blank page.
    if (await page.getByTestId("web-app-load-failed").isVisible()) {
      await page.getByTestId("web-app-load-failed").getByRole("button", { name: "Reload" }).tap();
    }
    await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 60_000 });
    expect(dropped.size).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

/**
 * What the phone experience has been tightened to, held. Soft, so one run
 * lists every breach; the report is written either way.
 *
 * Timings are generous against what the audit measures today (see the PR
 * that added them) so a slower CI box does not trip them, and tight enough
 * that undoing any of the fixes they came from does.
 */
const BUDGET = {
  /** The splash `web.html` paints before any script runs. */
  firstPaintMs: 800,
  /** The app's own shell, then a terminal showing its prompt. */
  appShellMs: 1_600,
  promptMs: 2_800,
  /** A round trip, plus what the page itself may spend on a keystroke —
   *  typically; and no keystroke stuck for a second. */
  echoP50Ms: PHONE_PROFILE.rttMs + 80,
  echoMaxMs: 1_000,
  /** From the line dropping to typing reaching the shell again. */
  reconnectMs: 5_000,
  /** Taps that change nothing on the host. */
  tapMs: 400,
  /** What a cold load may download before the terminal is up. */
  coldFontKB: 300,
  coldJsKB: 650,
};

/**
 * Axe rules that fail on the desk's own markup, not on anything phone-only,
 * and are left for a pass over the desk: the tab strip's tablist holds its
 * add button and a tab holds its close and mute buttons (ADR-175's keyboard
 * model), the sidebar's project header carries an ARIA attribute its role
 * does not allow, and cmdk's list points `aria-controls` at an id Radix has
 * not rendered. Listed so a *new* serious rule still fails the audit.
 */
const KNOWN_AXE = new Set([
  "aria-required-children",
  "nested-interactive",
  "aria-allowed-attr",
  "aria-valid-attr-value",
  // Moderate, page-level: a single-app page with no <main> or <h1>.
  "region",
  "landmark-one-main",
  "page-has-heading-one",
]);

function checkBudgets(report: AuditReport, log: string[]) {
  const t = report.timings;
  const one = (k: string) => t[k] as number;
  const many = (k: string) => t[k] as number[];

  for (const screen of report.screens) {
    const where = `${screen.name} (${screen.viewport.width}×${screen.viewport.height})`;
    const kinds = (k: string) => screen.layout.filter((i) => i.kind === k);
    expect.soft(kinds("page-overflow-x"), `${where}: page scrolls sideways`).toEqual([]);
    expect.soft(kinds("offscreen-x"), `${where}: something runs off the screen`).toEqual([]);
    expect.soft(kinds("input-zoom"), `${where}: a field iOS would zoom into`).toEqual([]);
    expect.soft(kinds("tiny-target"), `${where}: a tap target under 24px`).toEqual([]);
    expect.soft(kinds("clipped-text"), `${where}: text cut off without an ellipsis`).toEqual([]);
    const newAxe = screen.axe
      .filter((a) => (a.impact === "critical" || a.impact === "serious") && !KNOWN_AXE.has(a.id))
      .map((a) => `${a.id}: ${a.nodes[0]}`);
    expect.soft(newAxe, `${where}: axe`).toEqual([]);
  }

  expect.soft(one("cold: first contentful paint"), "first paint").toBeLessThan(BUDGET.firstPaintMs);
  expect.soft(one("cold: app shell on screen"), "app shell").toBeLessThan(BUDGET.appShellMs);
  expect.soft(one("cold: prompt on screen"), "prompt").toBeLessThan(BUDGET.promptMs);
  expect.soft(pct(many("keystroke → echo"), 50), "echo p50").toBeLessThan(BUDGET.echoP50Ms);
  expect.soft(Math.max(...many("keystroke → echo")), "echo max").toBeLessThan(BUDGET.echoMaxMs);
  for (const k of [
    "tap → drawer open",
    "tap → workspace switched",
    "swipe → drawer closed",
    "palette → pane switched",
    "tap → tab switched",
    "tap → palette open",
    "palette → settings open",
  ]) {
    expect.soft(one(k), k).toBeLessThan(BUDGET.tapMs);
  }

  expect.soft(one("network drop → terminal live again"), "reconnect").toBeLessThan(BUDGET.reconnectMs);
  expect.soft(one("long outage → terminal live again"), "reconnect after an outage").toBeLessThan(BUDGET.reconnectMs);

  const res = report.data.coldResources as ResourceSummary;
  expect.soft(res.byType.woff2?.transferKB ?? 0, "cold font download").toBeLessThan(BUDGET.coldFontKB);
  expect.soft(res.byType.ttf?.transferKB ?? 0, "cold TTF download").toBe(0);
  expect.soft(res.byType.js?.transferKB ?? 0, "cold JS download").toBeLessThan(BUDGET.coldJsKB);

  const terms = report.data.terminals as { mounted: number; webglCanvases: number };
  expect.soft(terms.webglCanvases, "WebGL contexts on a phone").toBe(0);
  expect.soft(report.data.tapFocusesTerminal, "a tap focuses the terminal").toBe(true);
  expect.soft(log.filter((l) => l.startsWith("[pageerror]")), "page errors").toEqual([]);
}
