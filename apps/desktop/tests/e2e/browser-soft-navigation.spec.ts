import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * A single-page app changes route with `history.pushState`, not a load. The
 * pane follows the new address in its URL bar, but must not load it: a load
 * throws away the page's state, scroll and transition. A marker set on
 * `window` before the client-side navigation survives only if the page was
 * never reloaded.
 */
test("a client-side navigation updates the URL bar without reloading the page", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<h1 style="font-family:sans-serif">SPA</h1>
       <a id="go" href="/settings" style="font-family:sans-serif">Settings</a>
       <script>
         document.getElementById("go").addEventListener("click", (e) => {
           e.preventDefault();
           history.pushState({}, "", "/settings");
           document.querySelector("h1").textContent = "Settings";
         });
       </script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const guest = (script: string) =>
    app.evaluate(
      async ({ webContents }, [prefix, js]) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
        if (!wc || wc.isLoading()) return null;
        return (await wc.executeJavaScript(js)) as unknown;
      },
      [base, script] as const,
    );

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-soft-nav");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");

    await expect.poll(() => guest(`window.__marker = "kept"; true`), { timeout: 10_000 }).toBe(true);
    await guest(`document.getElementById("go").click(); true`);

    const urlInput = window.locator("[data-pane-url-input]:visible");
    await expect(urlInput).toHaveValue(`${base}/settings`);
    // Give a stray reload time to land before checking the marker.
    await window.waitForTimeout(1_000);
    expect(await guest(`[location.pathname, window.__marker ?? null]`)).toEqual([
      "/settings",
      "kept",
    ]);
  } finally {
    server.close();
  }
});
