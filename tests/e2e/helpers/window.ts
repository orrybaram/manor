import type { ElectronApplication } from "@playwright/test";

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
