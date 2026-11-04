import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import type { ElectronApplication, Page } from "@playwright/test";
import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Right-clicking in a desk chat offers what a terminal does. On a link, that
 * starts with a new browser tab, a split beside the pane, the default browser
 * and the clipboard.
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

  // The same four items as a terminal's link, with the click a chat link
  // takes, ahead of the pane's own.
  await link.click({ button: "right" });
  const items = menu(window).locator('[role="menuitem"]');
  await expect(items.nth(0)).toHaveText("Open in New Browser Tab");
  await expect(items.nth(1)).toHaveText("Open in Browser Split");
  await expect(items.nth(2)).toContainText("Open in Default Browser");
  await expect(items.nth(2)).toContainText("Click");
  await expect(items.nth(3)).toHaveText("Copy Link");
  await expect(items.nth(4)).toHaveText("Copy");
  await expect(menu(window).getByRole("menuitem", { name: "Split Right" })).toBeVisible();
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

test("right-clicking in a desk chat offers what its terminal does, on the chat's text and composer", async ({
  app,
  window,
  tempHome,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const chatDir = path.join(tempHome, "fake-chat");

  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "chat-menu");
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(
    window,
    `"${FAKE_AGENT_TRANSCRIPT}" "${path.join(chatDir, "transcript.jsonl")}" "${path.join(chatDir, "input.log")}" e2e-chat-menu`,
  );
  await waitForVisibleSession(request, tempHome, { name: "e2e-chat-menu" });

  const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
  await pane.getByTestId("pane-chat-toggle").click({ timeout: 20_000 });
  const chat = pane.getByTestId("chat-pane");
  await expect(chat).toBeVisible({ timeout: 20_000 });
  const input = chat.getByTestId("chat-composer-input");
  await input.fill("hello menu");
  await chat.getByTestId("chat-send").click();
  const reply = chat.getByTestId("chat-assistant").filter({ hasText: "received: hello menu" });
  await expect(reply).toBeVisible({ timeout: 20_000 });

  // Nothing selected: the pane's items, with nothing to copy.
  await reply.click({ button: "right" });
  const items = menu(window).locator('[role="menuitem"]');
  const labels = await items.allTextContents();
  for (const label of ["Copy", "Paste", "Split Right", "Split Left", "Split Down", "Split Up", "Split with", "Convert to", "Close Pane"]) {
    expect(labels.some((l) => l.startsWith(label))).toBe(true);
  }
  expect(labels.some((l) => l.startsWith("Show Terminal"))).toBe(true);
  await expect(menu(window).getByRole("menuitem", { name: "Copy", exact: true })).toHaveAttribute("data-disabled", "");
  await window.screenshot({ path: testInfo.outputPath("chat-menu.png") });
  await window.keyboard.press("Escape");

  // Copy takes the chat's selected text.
  const replyText = reply.locator("p").first();
  await replyText.selectText();
  await replyText.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("received: hello menu");

  // Paste lands in the composer, at its caret.
  await app.evaluate(({ clipboard }) => clipboard.writeText("PASTED "));
  await input.fill("before after");
  await input.click({ button: "right" });
  await expect(menu(window)).toBeVisible();
  // After the right-click, which moves the caret itself.
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await menu(window).getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(input).toHaveValue("before PASTED after");
  await expect(input).toBeFocused();

  // A split, with the chat where it was.
  await reply.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: "Split Right" }).click();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect(chat).toBeVisible();

  // Show Terminal flips the pane.
  await reply.click({ button: "right" });
  await menu(window).getByRole("menuitem", { name: /^Show Terminal/ }).click();
  await expect(chat).toBeHidden();
  await expect(pane.getByTestId("terminal-pane")).toBeVisible();
});
