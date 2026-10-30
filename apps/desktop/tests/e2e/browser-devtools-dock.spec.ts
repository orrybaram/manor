import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * A browser pane's DevTools open docked in the pane, not in a window of their
 * own: a native `WebContentsView` main lays over the pane's DevTools slot
 * (`electron/browser-devtools-dock.ts`). It must sit in the pane's bottom
 * area, follow the drag handle and the dock-right toggle, hide while the
 * command palette is over it, and be gone once closed.
 */
test("DevTools open docked in a browser pane and hide under the command palette", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Inspect me</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  /** The guest, its DevTools and the view hosting them, as main sees them. */
  const dock = () =>
    app.evaluate(({ BrowserWindow, webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
      if (!guest) return null;
      const devTools = guest.devToolsWebContents;
      let view: { bounds: Electron.Rectangle; visible: boolean } | null = null;
      let views = 0;
      for (const win of BrowserWindow.getAllWindows()) {
        for (const child of win.contentView.children) {
          const wc = (child as Electron.WebContentsView).webContents as
            | Electron.WebContents
            | undefined;
          if (!wc || wc === win.webContents) continue;
          views += 1;
          if (devTools && wc.id === devTools.id) {
            view = { bounds: child.getBounds(), visible: child.getVisible() };
          }
        }
      }
      return {
        loaded: !guest.isLoading(),
        devToolsOpened: guest.isDevToolsOpened(),
        hasDevToolsWebContents: devTools !== null && !devTools.isDestroyed(),
        view,
        views,
        zoom: BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 1,
      };
    }, base);

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-devtools-dock");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await expect.poll(async () => (await dock())?.loaded ?? false, { timeout: 10_000 }).toBe(true);
    expect((await dock())?.views).toBe(0);

    // ── Open from the toolbar ──
    const toggle = window.locator('[data-testid="browser-devtools-toggle"]:visible');
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await dock())?.view?.visible ?? false, { timeout: 10_000 })
      .toBe(true);
    const opened = (await dock())!;
    expect(opened.devToolsOpened).toBe(true);
    expect(opened.hasDevToolsWebContents).toBe(true);
    expect(opened.views).toBe(1);

    // The view sits over the slot, under the page, in the pane's bottom part.
    const slot = (await window.locator('[data-testid="devtools-slot"]').boundingBox())!;
    const page = (await window.locator("webview:visible").boundingBox())!;
    const { bounds } = opened.view!;
    const z = opened.zoom;
    expect(Math.abs(bounds.x - slot.x * z)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y - slot.y * z)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - slot.width * z)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.height - slot.height * z)).toBeLessThanOrEqual(1);
    expect(bounds.y).toBeGreaterThanOrEqual((page.y + page.height) * z - 1);
    expect(bounds.x).toBeGreaterThanOrEqual(page.x * z - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual((page.x + page.width) * z + 1);
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-open.png" });

    // ── Hidden under the command palette ──
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.locator('[data-testid="command-palette"]')).toBeVisible();
    await expect
      .poll(async () => (await dock())?.view?.visible, { timeout: 5_000 })
      .toBe(false);
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-under-palette.png" });
    await window.keyboard.press("Escape");
    await expect(window.locator('[data-testid="command-palette"]')).toBeHidden();
    await expect
      .poll(async () => (await dock())?.view?.visible, { timeout: 5_000 })
      .toBe(true);

    // ── The drag handle resizes it ──
    const before = (await dock())!.view!.bounds.height;
    const handle = (await window.locator('[data-testid="devtools-handle"]').boundingBox())!;
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle.x + handle.width / 2, handle.y - 80, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(async () => {
        const state = await dock();
        return state?.view?.visible ? state.view.bounds.height : 0;
      }, { timeout: 5_000 })
      .toBeGreaterThan(before + 40);

    // ── Docked right ──
    await window.locator('[data-testid="devtools-dock-side"]').click();
    await expect
      .poll(async () => {
        const state = await dock();
        const pageNow = await window.locator("webview:visible").boundingBox();
        if (!state?.view?.visible || !pageNow) return false;
        return state.view.bounds.x >= (pageNow.x + pageNow.width) * state.zoom - 1;
      }, { timeout: 5_000 })
      .toBe(true);
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-right.png" });

    // ── Closing removes the view ──
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await dock())?.views, { timeout: 5_000 }).toBe(0);
    expect((await dock())?.devToolsOpened).toBe(false);
    await expect(window.locator('[data-testid="devtools-slot"]')).toHaveCount(0);
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-closed.png" });
  } finally {
    server.close();
  }
});
