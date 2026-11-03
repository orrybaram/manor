import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/** Hovering a link shows its URL in the pane's bottom-left corner, as a browser's status bubble does. */
test("hovering a link shows its URL in the status bubble", async ({ app, window, tempHome }) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<body style="margin:0;font:16px sans-serif">
         <a id="link" href="/billing/invoices?status=open"
            style="display:block;width:240px;height:60px;line-height:60px;padding-left:12px">Invoices</a>
       </body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-link-bubble");
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

    const box = await webview.boundingBox();
    expect(box).not.toBeNull();
    const bubble = window.locator('[data-testid="browser-link-bubble"]');
    await window.mouse.move(box!.x + 60, box!.y + 30);
    await expect(bubble).toHaveText(`${base}/billing/invoices?status=open`, { timeout: 10_000 });
    await window.screenshot({ path: "tests/e2e/artifacts/browser-link-bubble.png" });

    await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 40);
    await expect(bubble).toBeHidden({ timeout: 10_000 });
  } finally {
    server.close();
  }
});
