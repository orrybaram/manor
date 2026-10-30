import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ElectronApplication, Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

async function openBrowserPane(window: Page, url: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
  await window.keyboard.press("ControlOrMeta+l");
  await window.keyboard.type(url);
  await window.keyboard.press("Enter");
}

/** Run `script` in the guest whose URL starts with `prefix`, once it has loaded. */
function guest(app: ElectronApplication, prefix: string, script: string) {
  return app.evaluate(
    async ({ webContents }, [p, js]) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(p));
      if (!wc || wc.isLoading() || wc.isCrashed()) return null;
      return (await wc.executeJavaScript(js)) as unknown;
    },
    [prefix, script] as const,
  );
}

/**
 * A main-frame load that fails shows Manor's error page (host, sentence and
 * Chromium's code), and its Retry loads the page once it can.
 */
test("a failed load shows the error page, and Retry loads the page", async ({
  app,
  window,
  tempHome,
}) => {
  // The first request gets nothing back (ERR_EMPTY_RESPONSE); later ones the page.
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/" && requests++ === 0) {
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Back up</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-load-error");
    await openBrowserPane(window, `${base}/`);

    const errorPage = window.locator('[data-testid="browser-load-error"]');
    await expect(errorPage).toBeVisible({ timeout: 10_000 });
    await expect(errorPage).toContainText(`Couldn't load 127.0.0.1:${port}`);
    await expect(errorPage).toContainText("ERR_EMPTY_RESPONSE");
    await expect(errorPage).toContainText("without sending anything");
    await window.screenshot({ path: "tests/e2e/artifacts/browser-load-error.png" });

    await errorPage.getByRole("button", { name: "Retry" }).click();
    await expect(errorPage).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => guest(app, base, `document.querySelector("h1")?.textContent`), { timeout: 10_000 })
      .toBe("Back up");
  } finally {
    server.close();
  }
});

/** A host that doesn't resolve is a failed load too, named by its host. */
test("an unresolvable host shows the error page", async ({ app, window, tempHome }) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-load-dns");
  await openBrowserPane(window, "http://manor-e2e.invalid/");

  const errorPage = window.locator('[data-testid="browser-load-error"]');
  await expect(errorPage).toBeVisible({ timeout: 15_000 });
  await expect(errorPage).toContainText("Couldn't load manor-e2e.invalid");
  await expect(errorPage).toContainText(/ERR_[A-Z_]+/);
});

/** A guest whose renderer dies shows the crash page; Reload brings it back. */
test("a crashed page shows the crash page, and Reload recovers it", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Alive</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-crash");
    await openBrowserPane(window, `${base}/`);
    await expect.poll(() => guest(app, base, "true"), { timeout: 10_000 }).toBe(true);

    // `forcefullyCrashRenderer` can hang on Linux; a killed process is a crash too.
    await app.evaluate(({ webContents }, prefix) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
      if (wc) process.kill(wc.getOSProcessId(), "SIGKILL");
    }, base);

    const crashPage = window.locator('[data-testid="browser-crashed"]');
    await expect(crashPage).toBeVisible({ timeout: 10_000 });
    await expect(crashPage).toContainText("This page crashed");
    await window.screenshot({ path: "tests/e2e/artifacts/browser-crashed.png" });

    await crashPage.getByRole("button", { name: "Reload" }).click();
    await expect(crashPage).toBeHidden();
    await expect
      .poll(() => guest(app, base, `document.querySelector("h1")?.textContent`), { timeout: 10_000 })
      .toBe("Alive");
  } finally {
    server.close();
  }
});
