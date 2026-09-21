import { expect, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The app's windows, driven from the main process.
 *
 * Playwright talks to a renderer, not to the OS chrome around it, so
 * everything about a window *as a window* — its size, whether it exists at
 * all, the native menu clicked for it — is reached through `app.evaluate`.
 */

/**
 * How many renderer windows the app has open right now.
 *
 * Counts `BrowserWindow`s rather than Playwright pages because zero is the
 * interesting answer, and a page that has gone away is not a thing a test can
 * ask a question of.
 */
export function rendererWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
}

/**
 * Close every window and wait until none is left.
 *
 * `close()` rather than `destroy()`: it is the path a ⌘W or a red button
 * takes, which is what the app's own `closed` handlers are written for — the
 * viewer release in `app-lifecycle.ts` (ADR-180 D6) and the claim release
 * beside it (ADR-179 D4).
 *
 * On macOS the app outlives its last window, which is the state this exists
 * to produce: the daemon, the layout server and the control listener are all
 * still running with nothing on screen.
 */
export async function closeRendererWindows(
  app: ElectronApplication,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.close();
    }
  });
  await expect.poll(() => rendererWindowCount(app), { timeout: 15_000 }).toBe(0);
}

/**
 * Bring a window back the way clicking the dock icon does, and hand back its
 * page.
 *
 * `app.emit("activate")` rather than a private main-process function: the
 * `activate` handler is what reopens the primary window on macOS, and going
 * through it means the window under test is built by the same code that
 * builds the real one.
 */
export async function reopenPrimaryWindow(
  app: ElectronApplication,
): Promise<Page> {
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ app: electronApp }) => {
      electronApp.emit("activate");
    }),
  ]);
  await page.waitForLoadState("domcontentloaded");
  return page;
}

/**
 * Click a native menu item by its label path, e.g. `["File", "New Tab"]`.
 *
 * The menu lives in main and has no DOM, so this reaches the installed
 * template and clicks the item the way macOS would. `app-menu.spec.ts` and
 * `detach.spec.ts` each carry their own copy of this; new callers take this
 * one.
 */
export function clickMenuItem(
  app: ElectronApplication,
  labels: string[],
): Promise<void> {
  return app.evaluate(({ Menu, BrowserWindow }, path) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let item: Electron.MenuItem | undefined;
    for (const label of path) {
      item = items.find((candidate) => candidate.label === label);
      if (!item) throw new Error(`Menu item not found: ${path.join(" › ")}`);
      items = item.submenu?.items ?? [];
    }
    item!.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
  }, labels);
}

/**
 * Drag the window edge the way a hand on it does: many small steps, each held
 * long enough for the app to react, sweeping in and out repeatedly.
 *
 * Driven from the main process rather than through Playwright, which cannot
 * reach the OS window chrome. `setSize` goes through the same path a real drag
 * does: the renderer's ResizeObserver fires, the pane re-fits, and the pty is
 * told its new size.
 *
 * `holdMs` is the parameter that matters. Each step has to outlast
 * `SETTLE_MS`, or the whole sweep coalesces into the one size it ends on —
 * which is the design working, not a drag being tested.
 */
export async function dragWindowSize(
  app: ElectronApplication,
  steps: number,
  holdMs: number,
  { width: dw = 340, height: dh = 160, sweeps = 8 } = {},
): Promise<void> {
  await app.evaluate(
    async ({ BrowserWindow }, opts) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < opts.steps; i++) {
        const phase = Math.sin(((i + 0.5) / opts.steps) * Math.PI * opts.sweeps);
        win.setSize(
          Math.round(width + phase * opts.dw),
          Math.round(height + phase * opts.dh),
        );
        await sleep(opts.holdMs);
      }
      win.setSize(width, height);
    },
    { steps, holdMs, dw, dh, sweeps },
  );
}
