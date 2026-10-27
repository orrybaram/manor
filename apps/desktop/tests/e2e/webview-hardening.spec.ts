import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * A browser pane's `<webview>` guest gets no more than a plain browser tab: no
 * preload, no Node, sandboxed and isolated. `will-attach-webview` in
 * `electron/window.ts` forces this whatever the element's attributes say.
 */
test("a browser pane's guest has no Node and runs sandboxed", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<h1 style="font-family:sans-serif">Guest page</h1>
       <p id="reach" style="font-family:sans-serif"></p>
       <script>
         document.getElementById("reach").textContent =
           "require: " + typeof require + ", process: " + typeof process;
       </script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-webview-hardening");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, {
      timeout: 10_000,
    });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`http://127.0.0.1:${port}/`);
    await window.keyboard.press("Enter");

    const guest = () =>
      app.evaluate(async ({ webContents }) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith("http:"));
        if (!wc || wc.isLoading()) return null;
        const prefs = wc.getLastWebPreferences();
        return {
          preload: prefs?.preload ?? null,
          nodeIntegration: prefs?.nodeIntegration,
          contextIsolation: prefs?.contextIsolation,
          sandbox: prefs?.sandbox,
          reach: (await wc.executeJavaScript(
            `document.getElementById("reach").textContent`,
          )) as string,
        };
      });

    await expect.poll(guest, { timeout: 10_000 }).not.toBeNull();
    expect(await guest()).toEqual({
      preload: null,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      reach: "require: undefined, process: undefined",
    });

    await window.screenshot({ path: "tests/e2e/artifacts/webview-hardening.png" });
  } finally {
    server.close();
  }
});
