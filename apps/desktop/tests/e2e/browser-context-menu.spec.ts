import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * Right-clicking a link in a page offers it in a split, and choosing that
 * opens a browser pane beside this one on the link. The menu is native, so
 * the test keeps the template main builds instead of popping it up, and
 * runs the item's click itself.
 */
test("a page link's Open Link in Split opens a browser split on it", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/target"
        ? `<h1 style="font-family:sans-serif">Target</h1>`
        : `<body style="margin:0;font:16px sans-serif">
             <a href="/target" style="display:block;width:240px;height:60px;line-height:60px;padding-left:12px">Target</a>
           </body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-page-menu");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    const webview = window.locator("webview:visible");
    await expect(webview).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }, prefix) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
            return wc ? !wc.isLoading() : false;
          }, base),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Keep the template instead of showing a native menu.
    await app.evaluate(({ Menu }) => {
      const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
      Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
        kept.__pageMenu = template;
        return { popup: () => {} } as unknown as Electron.Menu;
      }) as typeof Menu.buildFromTemplate;
    });

    const box = await webview.boundingBox();
    expect(box).not.toBeNull();
    await window.mouse.click(box!.x + 60, box!.y + 30, { button: "right" });

    const labels = () =>
      app.evaluate(() => {
        const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
        return kept.__pageMenu?.map((i) => (i.type === "separator" ? "—" : i.label)) ?? null;
      });
    await expect.poll(labels, { timeout: 10_000 }).toEqual([
      "Back",
      "Forward",
      "Reload",
      "—",
      "Open Link in New Tab",
      "Open Link in Split",
      "Copy Link Address",
      "—",
      "Inspect Element",
    ]);

    await app.evaluate(() => {
      const kept = globalThis as unknown as { __pageMenu?: Electron.MenuItemConstructorOptions[] };
      const split = kept.__pageMenu?.find((i) => i.label === "Open Link in Split");
      (split?.click as (() => void) | undefined)?.();
    });

    await expect(webview).toHaveCount(2, { timeout: 10_000 });
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }, target) =>
            webContents
              .getAllWebContents()
              .some((w) => w.getType() === "webview" && w.getURL() === target && !w.isLoading()),
          `${base}/target`),
        { timeout: 10_000 },
      )
      .toBe(true);
    await window.screenshot({ path: "tests/e2e/artifacts/browser-open-link-in-split.png" });
  } finally {
    server.close();
  }
});
