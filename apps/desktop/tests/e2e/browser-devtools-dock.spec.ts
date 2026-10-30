import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ElectronApplication, Page } from "@playwright/test";
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
    // `isDevToolsOpened()` stays false for DevTools hosted in a view of our
    // own (Electron 44), so the live DevTools webContents is the check.
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
    // A page screenshot can't see a native view: capture the DevTools view's
    // own pixels too, to show the frontend is attached and inspecting.
    await app.evaluate(async ({ webContents }) => {
      const fs = process.mainModule!.require("node:fs") as typeof import("node:fs");
      const dt = webContents.getAllWebContents().find((w) => w.getURL().startsWith("devtools://"));
      if (dt) fs.writeFileSync("tests/e2e/artifacts/devtools-open-view.png", (await dt.capturePage()).toPNG());
    });

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

/**
 * A page that crashes with DevTools docked comes back with a fresh frontend
 * in the same place: the dead one is dropped once the page is reloaded.
 */
test("docked DevTools come back after the page crashes and reloads", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Crash me</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  /** The live DevTools webContents id for the guest, and its URL. */
  const devTools = () =>
    app.evaluate(({ webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
      const dt = guest?.devToolsWebContents;
      if (!guest || !dt || dt.isDestroyed() || guest.isCrashed()) return null;
      return { id: dt.id, url: dt.getURL() };
    }, base);

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-devtools-crash");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await window.locator('[data-testid="browser-devtools-toggle"]:visible').click();
    await expect.poll(devTools, { timeout: 10_000 }).not.toBeNull();
    const before = (await devTools())!;

    await app.evaluate(({ webContents }, prefix) => {
      webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix))!
        .forcefullyCrashRenderer();
    }, base);
    await expect.poll(devTools, { timeout: 10_000 }).toBeNull();
    await app.evaluate(({ webContents }, prefix) => {
      webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix))!
        .reload();
    }, base);

    // A fresh frontend, not the dead one, attached to the reloaded page.
    await expect
      .poll(
        async () => {
          const now = await devTools();
          return now && now.id !== before.id ? now.url : null;
        },
        { timeout: 10_000 },
      )
      .toMatch(/^devtools:\/\//);
    await expect(window.locator('[data-testid="devtools-slot"]')).toBeVisible();
  } finally {
    server.close();
  }
});

/** A page server answering `html` to every request, and its base URL. */
async function servePage(html: string): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** The guest on `prefix`, whether its page has loaded, and its docked DevTools view, as main sees them. */
function guestDock(app: ElectronApplication, prefix: string) {
  return app.evaluate(({ BrowserWindow, webContents }, prefix) => {
    const guest = webContents
      .getAllWebContents()
      .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
    if (!guest) return null;
    const devTools = guest.devToolsWebContents;
    let view: Electron.Rectangle | null = null;
    let views = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const wc = (child as Electron.WebContentsView).webContents as
          | Electron.WebContents
          | undefined;
        if (!wc || wc === win.webContents) continue;
        views += 1;
        if (devTools && !devTools.isDestroyed() && wc.id === devTools.id && child.getVisible()) {
          view = child.getBounds();
        }
      }
    }
    return {
      guestId: guest.id,
      loaded: !guest.isLoading(),
      view,
      views,
      zoom: BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 1,
    };
  }, prefix);
}

/** Open a browser tab on `url` and wait for its page. */
async function openBrowserTab(app: ElectronApplication, window: Page, url: string) {
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
  await window.keyboard.press("ControlOrMeta+l");
  await window.keyboard.type(url);
  await window.keyboard.press("Enter");
  await expect
    .poll(async () => (await guestDock(app, url))?.loaded ?? false, { timeout: 10_000 })
    .toBe(true);
}

/**
 * Moving a browser pane mounts it afresh, with a new page: the DevTools it
 * had open come back on the new page, on the same side.
 */
test("docked DevTools reopen on the same side after the browser pane moves", async ({
  app,
  window,
  tempHome,
}) => {
  const { server, base } = await servePage(`<h1 style="font-family:sans-serif">Move me</h1>`);
  const dock = () => guestDock(app, base);
  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-devtools-move");
    await openBrowserTab(app, window, `${base}/`);

    await window.locator('[data-testid="browser-devtools-toggle"]:visible').click();
    await window.locator('[data-testid="devtools-dock-side"]').click();
    /** The DevTools view sits right of the page. */
    const dockedRight = async () => {
      const state = await dock();
      const page = await window.locator("webview:visible").boundingBox();
      if (!state?.view || !page) return false;
      return state.view.x >= (page.x + page.width) * state.zoom - 1;
    };
    await expect.poll(dockedRight, { timeout: 10_000 }).toBe(true);
    const before = (await dock())!;

    // Drag the browser tab to the empty right of its bar: a new panel.
    const bar = (await window.locator('[role="tablist"]').first().boundingBox())!;
    const x = bar.x + bar.width * 0.85;
    const y = bar.y + bar.height / 2;
    await window.evaluate(() => {
      const tab = document.querySelector('[data-testid="tab"][aria-selected="true"]')!;
      const r = tab.getBoundingClientRect();
      const dt = new DataTransfer();
      (window as unknown as { __dt: DataTransfer }).__dt = dt;
      tab.dispatchEvent(
        new DragEvent("dragstart", {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: r.left + 10,
          clientY: r.top + 10,
        }),
      );
    });
    // The bar reads the drag from React state, so let it render first.
    await window.waitForTimeout(100);
    await window.evaluate(({ x, y }) => {
      const dt = (window as unknown as { __dt: DataTransfer }).__dt;
      const target = document.elementFromPoint(x, y)!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }),
        );
      }
    }, { x, y });
    await expect(window.locator('[role="tablist"]')).toHaveCount(2, { timeout: 10_000 });

    // A new page, with DevTools open on it again, still on the right.
    await expect
      .poll(async () => {
        const state = await dock();
        return state && state.guestId !== before.guestId && state.view !== null;
      }, { timeout: 15_000 })
      .toBe(true);
    await expect.poll(dockedRight, { timeout: 5_000 }).toBe(true);
    expect((await dock())?.views).toBe(1);
    await expect(window.locator('[data-testid="browser-devtools-toggle"]:visible')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-after-move.png" });
  } finally {
    server.close();
  }
});

/**
 * The page's own menu offers Inspect Element, and choosing it opens DevTools
 * docked in the pane. The menu is native, so the test keeps the template main
 * builds instead of popping it up, and runs the item's click itself.
 */
test("Inspect Element from the page's menu opens docked DevTools", async ({
  app,
  window,
  tempHome,
}) => {
  const { server, base } = await servePage(
    `<body style="margin:0"><h1 id="target" style="font-family:sans-serif;margin:0;padding:20px">Inspect me</h1></body>`,
  );
  const dock = () => guestDock(app, base);
  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-devtools-inspect");
    await openBrowserTab(app, window, `${base}/`);
    expect((await dock())?.views).toBe(0);

    // Keep the page menu's template instead of showing a native menu. Only
    // that one: the app menu builds through the same call and must get a
    // real menu.
    await app.evaluate(({ Menu }) => {
      const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
        if (!template.some((i) => i.label === "Inspect Element")) return build(template);
        kept.__pageMenu = template;
        return { popup: () => {} } as unknown as Electron.Menu;
      }) as typeof Menu.buildFromTemplate;
    });

    const box = (await window.locator("webview:visible").boundingBox())!;
    await window.mouse.click(box.x + 60, box.y + 30, { button: "right" });
    await expect
      .poll(
        () =>
          app.evaluate(() => {
            const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
            return kept.__pageMenu?.some((i) => i.label === "Inspect Element") ?? false;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    await app.evaluate(() => {
      const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
      const inspect = kept.__pageMenu?.find((i) => i.label === "Inspect Element");
      (inspect?.click as (() => void) | undefined)?.();
    });

    await expect.poll(async () => (await dock())?.view ?? null, { timeout: 10_000 }).not.toBeNull();
    expect((await dock())?.views).toBe(1);
    await expect(window.locator('[data-testid="devtools-slot"]')).toBeVisible();
    await expect(window.locator('[data-testid="browser-devtools-toggle"]:visible')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await window.screenshot({ path: "tests/e2e/artifacts/devtools-inspect-element.png" });
  } finally {
    server.close();
  }
});
