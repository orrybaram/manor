import type { Page } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  openTerminalTab,
  test,
} from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Hidden panes stay mounted and keep parsing their output, but must not paint
 * it (#300). xterm pauses painting while its IntersectionObserver reports the
 * terminal off screen; `visibility: hidden` alone doesn't, so hidden layers
 * are also moved out of the viewport (`tab-styles.ts`). A pane hidden as a
 * background tab, and one hidden because its whole workspace is, both stop
 * painting, keep their grid size, and repaint in full once shown.
 */

interface PaintStats {
  renders: number;
  fullRenders: number;
  parsed: number;
  resizes: number;
  cols: number;
  rows: number;
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
      parsed: 0,
      resizes: 0,
      cols: term.cols,
      rows: term.rows,
    };
    window.__paintStats[id] = stats;
    term.onRender(({ start, end }) => {
      stats.renders++;
      if (start === 0 && end === term.rows - 1) stats.fullRenders++;
    });
    term.onWriteParsed(() => stats.parsed++);
    term.onResize(() => stats.resizes++);
  }, paneId);
}

/** Zero the counters, keeping the listeners and the starting size. */
async function resetPaints(window: Page, paneId: string): Promise<void> {
  await window.evaluate((id) => {
    const stats = window.__paintStats?.[id];
    if (!stats) throw new Error(`not watching ${id}`);
    stats.renders = 0;
    stats.fullRenders = 0;
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

/** Assert the hidden pane keeps parsing output but paints none of it. */
async function expectPausedWhileWriting(
  window: Page,
  paneId: string,
): Promise<void> {
  // Let the observer report the layer off screen, then count from zero.
  await window.waitForTimeout(300);
  await resetPaints(window, paneId);
  await window.waitForTimeout(1_500);
  const stats = await paints(window, paneId);
  expect(stats.parsed).toBeGreaterThan(0);
  expect(stats.renders).toBe(0);
}

/** Assert the shown pane repaints its whole grid. */
async function expectFullRepaint(window: Page, paneId: string): Promise<void> {
  await expect
    .poll(async () => (await paints(window, paneId)).fullRenders, {
      timeout: 5_000,
    })
    .toBeGreaterThan(0);
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

  // A busy agent's stand-in: a line of output every 20 ms, forever.
  await runInTerminal(
    window,
    "i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.02; done",
  );
  await expect
    .poll(async () => (await paints(window, busy)).renders)
    .toBeGreaterThan(0);

  // Hidden as a background tab in the visible workspace.
  await openTerminalTab(window);
  await expectPausedWhileWriting(window, busy);

  await resetPaints(window, busy);
  await window.locator('[data-testid="tab"]').first().click();
  await expect.poll(() => activePaneId(window)).toBe(busy);
  await expectFullRepaint(window, busy);

  // The selected tab of a hidden workspace: a visible layer inside a hidden
  // one must stay off screen too.
  await createWorkspace(window, "ws-other");
  await openTerminalTab(window);
  await expectPausedWhileWriting(window, busy);

  await resetPaints(window, busy);
  await window
    .locator('[data-testid="workspace-item"]', { hasText: "ws-paint" })
    .first()
    .click();
  await expect.poll(() => activePaneId(window)).toBe(busy);
  await expectFullRepaint(window, busy);

  // Hiding and showing never moved the grid, so no resize reached the pty.
  const end = await paints(window, busy);
  expect(end.resizes).toBe(0);
  expect(await gridSize(window, busy)).toEqual(size);

  await window.keyboard.press("Control+c");
});
