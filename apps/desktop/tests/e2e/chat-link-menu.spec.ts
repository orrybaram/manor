import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import type { ElectronApplication, Page } from "@playwright/test";
import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Right-clicking a link in a desk chat offers what a terminal's does: a new
 * browser tab, a split beside the pane, the default browser, the clipboard.
 * The link is the fake agent's echo of a sent message, autolinked by the
 * chat's markdown, and points at a page served from this test.
 */

let server: http.Server;
let base: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<body style="font:24px system-ui;padding:24px">Served at ${req.url}</body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  server.close();
});

function menu(window: Page) {
  return window.locator('[role="menu"]');
}

function visibleBrowserSrcs(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="workspace-pane"]:visible webview')
    .evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
}

async function stubOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __openedUrls: string[] }).__openedUrls = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __openedUrls?: string[] }).__openedUrls ?? [],
  );
}

test("right-clicking a link in a desk chat offers Manor's browser, the default browser and the clipboard", async ({
  app,
  window,
  tempHome,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const chatDir = path.join(tempHome, "fake-chat");

  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "chat-links");
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await stubOpenExternal(app);
  await runInTerminal(
    window,
    `"${FAKE_AGENT_TRANSCRIPT}" "${path.join(chatDir, "transcript.jsonl")}" "${path.join(chatDir, "input.log")}" e2e-chat-links`,
  );
  await waitForVisibleSession(request, tempHome, { name: "e2e-chat-links" });

  const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
  await pane.getByTestId("pane-chat-toggle").click({ timeout: 20_000 });
  const chat = pane.getByTestId("chat-pane");
  await expect(chat).toBeVisible({ timeout: 20_000 });

  const url = `${base}/dev-server`;
  await chat.getByTestId("chat-composer-input").fill(`try ${url}`);
  await chat.getByTestId("chat-send").click();
  const link = chat.getByTestId("chat-assistant").locator(`a[href="${url}"]`);
  await expect(link).toBeVisible({ timeout: 20_000 });
  // The reply's typing and entrance have settled, so the link stays put.
  await expect(chat.getByTestId("chat-assistant").filter({ hasText: `received: try ${url}` })).toBeVisible();

  // The same four items as a terminal's link, with the click a chat link takes.
  await link.click({ button: "right" });
  const items = menu(window).locator('[role="menuitem"]');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveText("Open in New Browser Tab");
  await expect(items.nth(1)).toHaveText("Open in Browser Split");
  await expect(items.nth(2)).toContainText("Open in Default Browser");
  await expect(items.nth(2)).toContainText("Click");
  await expect(items.nth(3)).toHaveText("Copy Link");
  await window.screenshot({ path: testInfo.outputPath("chat-link-menu.png") });

  // Default browser.
  await items.nth(2).click();
  await expect.poll(() => openedUrls(app)).toEqual([url]);

  // Clipboard.
  await link.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: "Copy Link" }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(url);

  // A split beside the chat, which stays where it was.
  await link.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: "Open in Browser Split" }).click();
  await expect.poll(() => visibleBrowserSrcs(window), { timeout: 15_000 }).toEqual([url]);
  await expect(chat).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath("chat-link-split.png") });

  // A new tab, which hides the first tab's panes.
  await link.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: "Open in New Browser Tab" }).click();
  await expect(chat).toBeHidden();
  await expect.poll(() => visibleBrowserSrcs(window), { timeout: 15_000 }).toEqual([url]);
});
