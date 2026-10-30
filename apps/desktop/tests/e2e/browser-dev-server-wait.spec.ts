import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/** A loopback port nothing listens on (yet). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * A pane opened on a dev server that isn't up yet waits for it instead of
 * showing the error page, retrying on a backoff, and loads the page on its
 * own once the server starts listening.
 */
test("a pane on a dev server that isn't up yet waits, then loads it", async ({
  app,
  window,
  tempHome,
}) => {
  const port = await freePort();
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Dev server</h1>`);
  });

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-dev-wait");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`localhost:${port}`);
    await window.keyboard.press("Enter");

    const waiting = window.locator('[data-testid="browser-waiting"]');
    await expect(waiting).toBeVisible({ timeout: 10_000 });
    await expect(waiting).toContainText(`Waiting for localhost:${port}…`);
    await expect(waiting).toContainText("Nothing is listening yet.");
    await expect(waiting).toContainText(/attempt \d+/);
    // Several refusals in, it is still waiting, not on the error page.
    await window.waitForTimeout(2_500);
    await expect(waiting).toBeVisible();
    await expect(window.locator('[data-testid="browser-load-error"]')).toHaveCount(0);
    await window.screenshot({ path: "tests/e2e/artifacts/browser-dev-server-wait.png" });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    await expect(waiting).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(
        () =>
          app.evaluate(async ({ webContents }, p) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getType() === "webview" && w.getURL().includes(`:${p}/`));
            if (!wc || wc.isLoading()) return null;
            return (await wc.executeJavaScript(`document.querySelector("h1")?.textContent`)) as unknown;
          }, port),
        { timeout: 10_000 },
      )
      .toBe("Dev server");
  } finally {
    server.close();
  }
});

/** Cancel gives up on the wait and shows the error page for the refusal. */
test("cancelling the wait shows the error page", async ({ app, window, tempHome }) => {
  const port = await freePort();
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-dev-wait-cancel");
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
  await window.keyboard.press("ControlOrMeta+l");
  await window.keyboard.type(`http://127.0.0.1:${port}/`);
  await window.keyboard.press("Enter");

  const waiting = window.locator('[data-testid="browser-waiting"]');
  await expect(waiting).toBeVisible({ timeout: 10_000 });
  await waiting.getByRole("button", { name: "Cancel" }).click();

  const errorPage = window.locator('[data-testid="browser-load-error"]');
  await expect(errorPage).toBeVisible();
  await expect(errorPage).toContainText(`Couldn't load 127.0.0.1:${port}`);
  await expect(errorPage).toContainText("ERR_CONNECTION_REFUSED");
  // And it stays given up: no retry brings the wait back.
  await window.waitForTimeout(2_500);
  await expect(waiting).toHaveCount(0);
});
