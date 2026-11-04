import http from "node:http";
import type { AddressInfo } from "node:net";
import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { setAgentCommand } from "./helpers/settings";

/**
 * A page's notes sent to a new agent leave that agent in the workspace: the
 * next note's Send to… offers it.
 */
test("an agent a page's notes started is offered for the next note", async ({ app, window, tempHome }) => {
  test.setTimeout(180_000);
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<body style="margin:0;padding:24px;font:14px sans-serif">
         ${[1, 2]
           .map(
             (n) =>
               `<div id="card-${n}" style="margin:0 0 16px;padding:16px;width:280px;height:48px;border:1px solid #ddd">Card ${n}</div>`,
           )
           .join("")}
       </body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const guest = <T,>(script: string) =>
    app.evaluate(
      async ({ webContents }, [prefix, js]) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
        if (!wc || wc.isLoading()) return null;
        return (await wc.executeJavaScript(js)) as unknown;
      },
      [base, script] as const,
    ) as Promise<T | null>;

  try {
    await importSeededProject(app, window, tempHome);
    await setAgentCommand(window, "test-project", `"${FAKE_AGENT}"`);
    await createWorkspace(window, "ws-pins-new");
    await openTerminalTab(window);

    await window.keyboard.press("ControlOrMeta+Shift+b");
    const webview = window.locator("webview:visible");
    await expect(webview).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await expect.poll(() => guest<boolean>("!!document.getElementById('card-2')"), { timeout: 10_000 }).toBe(true);

    const pick = async (n: number) => {
      await window.getByTestId("browser-pick-toggle").click();
      await expect.poll(() => guest<boolean>("!!window.__manor_pins__")).toBe(true);
      const box = (await window.locator("webview:visible").boundingBox())!;
      const rect = (await guest<{ x: number; y: number }>(
        `(() => { const r = document.getElementById("card-${n}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ))!;
      await window.mouse.click(box.x + rect.x, box.y + rect.y);
      const input = window.getByTestId("browser-note-input");
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill(`note ${n}`);
      await input.press("Enter");
      await window.keyboard.press("Escape");
    };
    const browserTab = window.locator('[role="tab"]', { hasText: "127.0.0.1" }).first();

    await test.step("first note goes to a new agent", async () => {
      await pick(1);
      await window.getByTestId("browser-notes-send").click();
      await window.getByTestId("browser-notes-targets").getByRole("button", { name: "New agent" }).click();
      await expect(window.getByTestId("browser-notes-pill")).toHaveCount(0);
    });

    await test.step("the next note offers that agent", async () => {
      // Let the new agent register.
      await window.waitForTimeout(8_000);
      await window.screenshot({ path: "tests/e2e/artifacts/pins-new-agent-launched.png" });
      await browserTab.click().catch(() => undefined);
      await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
      await pick(2);
      await window.getByTestId("browser-notes-send").click();
      const menu = window.getByTestId("browser-notes-targets");
      await expect(menu).toBeVisible();
      await window.screenshot({ path: "tests/e2e/artifacts/pins-new-agent-menu.png" });
      const agents = await window.evaluate(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).electronAPI.agents.getAll({}),
      );
      console.log("AGENTS", JSON.stringify(agents.map((a: Record<string, unknown>) => ({ ws: a.workspacePath, host: a.hostId, status: a.status, pane: a.paneId, name: a.name }))));
      await expect(menu.getByRole("button")).toHaveCount(4, { timeout: 15_000 });
    });
  } finally {
    server.close();
  }
});
