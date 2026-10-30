import net from "node:net";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/** A loopback port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * A blank browser pane lists the dev servers detected in its workspace (the
 * ports the sidebar's port badges show), and a click loads one in the pane.
 */
test("a blank browser pane lists the workspace's servers, and a click opens one", async ({
  app,
  window,
  tempHome,
}) => {
  const port = await freePort();
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-blank-servers");
  await awaitShellReady(window, tempHome, await activePaneId(window));

  // A dev server started from the workspace's own terminal, so its cwd is in
  // the workspace and the scanner files it there.
  await runInTerminal(
    window,
    `node -e "require('http').createServer((q, r) => r.end('<h1>From the workspace</h1>')).listen(${port}, '127.0.0.1')"`,
  );

  try {
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });

    const list = window.locator('[data-testid="browser-blank-servers"]');
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list).toContainText("Running in this workspace");
    const row = list.getByRole("button", { name: `Open localhost:${port}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("node");
    await expect(list).toContainText("or type a URL above");
    await window.screenshot({ path: "tests/e2e/artifacts/browser-blank-servers.png" });

    await row.click();
    await expect(list).toBeHidden({ timeout: 10_000 });
    await expect(window.locator("[data-pane-url-input]:visible")).toHaveValue(
      `http://localhost:${port}/`,
      { timeout: 10_000 },
    );
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
      .toBe("From the workspace");
  } finally {
    // Don't leave the dev server behind with the test's daemon.
    type Scanned = { port: number; pid: number };
    const ports = (await window
      .evaluate(() => (globalThis as unknown as Window).electronAPI.ports.scanNow())
      .catch(() => [])) as Scanned[];
    const pid = ports.find((p) => p.port === port)?.pid;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  }
});
