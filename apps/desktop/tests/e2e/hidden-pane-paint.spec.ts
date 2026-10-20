import type { Locator, Page } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  openTerminalTab,
  test,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";

/**
 * Hidden panes stay mounted and keep parsing their output, but must not paint
 * it (#300). xterm pauses painting while its IntersectionObserver reports the
 * terminal off screen; `visibility: hidden` alone doesn't, so a terminal under
 * a hidden layer is also moved out of the viewport (`hiddenLayerAttr` in
 * `tab-styles.ts`). A pane hidden as a background tab, and one hidden because
 * its whole workspace is, both stop painting, keep their grid size, and
 * repaint in full, with current content, once shown. Browser panes stay as
 * they were: throttled while hidden.
 */

const LOOP = "i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.02; done";

interface PaintStats {
  renders: number;
  fullRenders: number;
  firstFullAt: number | null;
  parsed: number;
  resizes: number;
}

declare global {
  interface Window {
    __paintStats?: Record<string, PaintStats>;
  }
}

/** Count paints, parses and resizes on a pane's terminal from here on. */
async function watchPaints(window: Page, paneId: string): Promise<void> {
  await window.evaluate((id) => {
    const term = window.__manorTerminals?.get(id)?.term;
    if (!term) throw new Error(`no terminal registered for ${id}`);
    window.__paintStats ??= {};
    const stats: PaintStats = {
      renders: 0,
      fullRenders: 0,
      firstFullAt: null,
      parsed: 0,
      resizes: 0,
    };
    window.__paintStats[id] = stats;
    term.onRender(({ start, end }) => {
      stats.renders++;
      if (start === 0 && end === term.rows - 1) {
        stats.fullRenders++;
        stats.firstFullAt ??= performance.now();
      }
    });
    term.onWriteParsed(() => stats.parsed++);
    term.onResize(() => stats.resizes++);
  }, paneId);
}

/** Zero the paint and parse counters, keeping the listeners. */
async function resetPaints(window: Page, paneId: string): Promise<void> {
  await window.evaluate((id) => {
    const stats = window.__paintStats?.[id];
    if (!stats) throw new Error(`not watching ${id}`);
    stats.renders = 0;
    stats.fullRenders = 0;
    stats.firstFullAt = null;
    stats.parsed = 0;
  }, paneId);
}

async function paints(window: Page, paneId: string): Promise<PaintStats> {
  return window.evaluate((id) => {
    const stats = window.__paintStats?.[id];
    if (!stats) throw new Error(`not watching ${id}`);
    return { ...stats };
  }, paneId);
}

/** The terminal's current grid size. */
async function gridSize(
  window: Page,
  paneId: string,
): Promise<{ cols: number; rows: number }> {
  return window.evaluate((id) => {
    const term = window.__manorTerminals?.get(id)?.term;
    if (!term) throw new Error(`no terminal registered for ${id}`);
    return { cols: term.cols, rows: term.rows };
  }, paneId);
}

/** Type into a pane's pty through its terminal: works while it is hidden. */
async function input(window: Page, paneId: string, data: string) {
  await window.evaluate(
    ([id, d]) => window.__manorTerminals?.get(id)?.term.input(d),
    [paneId, data] as const,
  );
}

/** The last `tick N` line in the terminal's buffer. */
async function lastTickInBuffer(window: Page, paneId: string): Promise<string> {
  return window.evaluate((id) => {
    const buf = window.__manorTerminals?.get(id)?.term.buffer.active;
    if (!buf) throw new Error(`no terminal registered for ${id}`);
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y)?.translateToString(true) ?? "";
      if (/^tick \d+$/.test(line)) return line;
    }
    return "";
  }, paneId);
}

/** The last `tick N` line the pty wrote, from the daemon's scrollback. */
function lastTickWritten(tempHome: string, paneId: string): string {
  const ticks = scrollback(tempHome, paneId).match(/^tick \d+$/gm);
  return ticks?.at(-1) ?? "";
}

/**
 * While output keeps arriving, the hidden pane parses it but paints none of
 * it. Retried: a paint queued just before the layer went off screen may land
 * inside the first window.
 */
async function expectPausedWhileWriting(
  window: Page,
  paneId: string,
): Promise<void> {
  await expect(async () => {
    await resetPaints(window, paneId);
    await window.waitForTimeout(1_000);
    const stats = await paints(window, paneId);
    expect(stats.parsed).toBeGreaterThan(0);
    expect(stats.renders).toBe(0);
  }).toPass({ timeout: 15_000 });
}

/**
 * Stop the loop from behind the hidden layer and let its output drain, so the
 * only paint left to come is the one showing the pane makes.
 */
async function stopWhileHidden(window: Page, paneId: string): Promise<void> {
  await input(window, paneId, "\x03");
  await expect(async () => {
    await resetPaints(window, paneId);
    await window.waitForTimeout(500);
    expect((await paints(window, paneId)).parsed).toBe(0);
  }).toPass({ timeout: 10_000 });
  expect((await paints(window, paneId)).renders).toBe(0);
}

/** Show the pane by clicking `target`; it repaints in full, with current content. */
async function showAndExpectRepaint(
  window: Page,
  tempHome: string,
  paneId: string,
  target: Locator,
): Promise<void> {
  await resetPaints(window, paneId);
  const shownAt = await window.evaluate(() => performance.now());
  await target.click();
  await expect.poll(() => activePaneId(window)).toBe(paneId);
  await expect
    .poll(async () => (await paints(window, paneId)).fullRenders, {
      timeout: 5_000,
    })
    .toBeGreaterThan(0);
  const { firstFullAt } = await paints(window, paneId);
  console.log(`full repaint ${Math.round(firstFullAt! - shownAt)} ms after show`);

  // The daemon flushes its scrollback file behind the stream, so wait for it
  // to catch up with the last line the pty wrote.
  const shown = await lastTickInBuffer(window, paneId);
  expect(shown).not.toBe("");
  await expect.poll(() => lastTickWritten(tempHome, paneId)).toBe(shown);
}

test("a hidden pane keeps parsing but stops painting, then repaints when shown", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-paint");
  const busy = await activePaneId(window);
  await awaitShellReady(window, tempHome, busy);
  await watchPaints(window, busy);
  const size = await gridSize(window, busy);
  const busyTab = window.locator('[data-testid="tab"]:visible').first();

  // A busy agent's stand-in: a line of output every 20 ms, forever.
  await runInTerminal(window, LOOP);
  await expect
    .poll(async () => (await paints(window, busy)).renders)
    .toBeGreaterThan(0);

  // Hidden as a background tab in the visible workspace.
  await openTerminalTab(window);
  await expectPausedWhileWriting(window, busy);
  await stopWhileHidden(window, busy);
  await showAndExpectRepaint(window, tempHome, busy, busyTab);

  // The selected tab of a hidden workspace: a shown layer inside a hidden one
  // must stay off screen too.
  await runInTerminal(window, LOOP);
  await createWorkspace(window, "ws-other");
  await openTerminalTab(window);
  await expectPausedWhileWriting(window, busy);
  await stopWhileHidden(window, busy);
  await showAndExpectRepaint(
    window,
    tempHome,
    busy,
    window
      .locator('[data-testid="workspace-item"]', { hasText: "ws-paint" })
      .first(),
  );

  // Hiding and showing never moved the grid, so no resize reached the pty.
  expect((await paints(window, busy)).resizes).toBe(0);
  expect(await gridSize(window, busy)).toEqual(size);
});

test("a browser pane in a hidden tab stays throttled", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-browser-paint");
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, {
    timeout: 10_000,
  });
  await window.keyboard.press("ControlOrMeta+l");
  await window.keyboard.type("about:blank");
  await window.keyboard.press("Enter");

  /**
   * Animation frames the page got over one second. The page keeps drawing,
   * like a dev server's preview would: a hidden page that draws nothing is
   * never throttled, so it would prove nothing either way.
   */
  const framesPerSecond = () =>
    app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === "webview");
      if (!guest) throw new Error("no webview guest");
      const count = () =>
        guest.executeJavaScript(
          `window.__frames ??= (() => {
            let n = 0;
            const f = () => { n++; requestAnimationFrame(f); };
            requestAnimationFrame(f);
            setInterval(() => {
              document.body.style.background = \`hsl(\${n % 360} 50% 50%)\`;
            }, 50);
            return { get n() { return n; } };
          })();
          window.__frames.n`,
        ) as Promise<number>;
      const before = await count();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return (await count()) - before;
    });

  await expect.poll(framesPerSecond, { timeout: 10_000 }).toBeGreaterThan(30);

  await openTerminalTab(window);
  await expect.poll(framesPerSecond, { timeout: 10_000 }).toBeLessThan(10);
});
