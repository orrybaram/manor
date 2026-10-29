import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, paneText, runInTerminal } from "./helpers/terminal";

/**
 * Right-clicking a link in a terminal offers Manor's browser (#436): a new
 * tab, a split beside the terminal, the default browser, or the clipboard.
 * Off a link, the terminal's menu is what it was.
 *
 * The links point at a page served from this test, so the browser panes have
 * something to show.
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

const LINK_ITEMS = [
  "Open in New Browser Tab",
  "Open in Browser Split",
  "Open in Default Browser",
  "Copy Link",
];

/** The menu Radix opened on right-click. */
function menu(window: Page) {
  return window.locator('[role="menu"]');
}

/**
 * Move the pointer onto the last place `text` is printed in the pane, then
 * right-click there. The last, because the command that printed it echoed
 * it first.
 */
async function rightClickText(window: Page, paneId: string, text: string): Promise<void> {
  const pos = await window.evaluate(
    ({ id, needle }) => {
      const term = window.__manorTerminals!.get(id)!.term;
      const buf = term.buffer.active;
      for (let y = buf.length - 1; y >= 0; y--) {
        const line = buf.getLine(y)?.translateToString(true) ?? "";
        const x = line.lastIndexOf(needle);
        if (x < 0) continue;
        const screen = term.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
        const cellW = screen.width / term.cols;
        const cellH = screen.height / term.rows;
        return {
          x: screen.left + (x + 2.5) * cellW,
          y: screen.top + (y - buf.viewportY + 0.5) * cellH,
        };
      }
      throw new Error(`"${needle}" is not in the pane`);
    },
    { id: paneId, needle: text },
  );
  // Two moves: xterm finds links on mousemove, so arrive rather than appear.
  await window.mouse.move(pos.x - 8, pos.y);
  await window.mouse.move(pos.x, pos.y);
  await window.waitForTimeout(300);
  await window.mouse.click(pos.x, pos.y, { button: "right" });
  await expect(menu(window)).toBeVisible();
}

async function closeMenu(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(menu(window)).toBeHidden();
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

/** A line of `paneText` that starts with `text`, past any SGR codes it opens with. */
function lineStarting(text: string): RegExp {
  return new RegExp(`^(\\x1b\\[[\\d;]*m)*${text}`, "m");
}

function shot(testInfo: TestInfo, name: string): string {
  return testInfo.outputPath(`${name}.png`);
}

/** The `src` of every visible browser pane's webview. */
function webviewSrcs(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="workspace-pane"]:visible webview')
    .evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
}

const LIGHT_THEME = "E2E Light";

/** GitHub Light's palette as a Ghostty theme, where the theme manager looks. */
function installLightTheme(tempHome: string): void {
  const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
  fs.mkdirSync(dir, { recursive: true });
  const palette = [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ];
  fs.writeFileSync(
    path.join(dir, LIGHT_THEME),
    [
      ...palette.map((c, i) => `palette = ${i}=${c}`),
      "background = #ffffff",
      "foreground = #1f2328",
      "cursor-color = #0969da",
      "selection-background = #dbe9f9",
      "selection-foreground = #1f2328",
      "",
    ].join("\n"),
  );
}

async function useLightTheme(window: Page): Promise<void> {
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))
    .not.toBe("#1e1e2e");
}

test("right-clicking a printed URL offers Manor's browser, the default browser and the clipboard", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-links");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await stubOpenExternal(app);

  const url = `${base}/dev-server`;
  await runInTerminal(window, `echo "  Local:   ${url}"`);
  await expect.poll(() => paneText(window, paneId)).toMatch(/Local: {3}http/);

  // The link's items lead the terminal's own menu, which is all still there.
  await rightClickText(window, paneId, url);
  const items = menu(window).locator('[role="menuitem"]');
  await expect(items.nth(0)).toHaveText("Open in New Browser Tab");
  await expect(items.nth(1)).toHaveText("Open in Browser Split");
  await expect(items.nth(2)).toContainText("Open in Default Browser");
  await expect(items.nth(2)).toContainText(/⌘ Click|Ctrl Click/);
  await expect(items.nth(3)).toHaveText("Copy Link");
  await expect(menu(window).getByRole("menuitem", { name: "Paste" })).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "link-menu-dark") });
  await menu(window).screenshot({ path: shot(testInfo, "link-menu-dark-closeup") });
  await closeMenu(window);

  await useLightTheme(window);
  await rightClickText(window, paneId, url);
  await window.screenshot({ path: shot(testInfo, "link-menu-light") });
  await menu(window).screenshot({ path: shot(testInfo, "link-menu-light-closeup") });

  // Copy Link
  await menu(window).getByRole("menuitem", { name: "Copy Link" }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);

  // Open in Default Browser: the same call Cmd/Ctrl-click makes.
  await rightClickText(window, paneId, url);
  await menu(window).getByRole("menuitem", { name: /Open in Default Browser/ }).click();
  await expect.poll(() => openedUrls(app)).toEqual([url]);

  // Open in Browser Split: the terminal stays, a browser opens beside it.
  await rightClickText(window, paneId, url);
  await menu(window).getByRole("menuitem", { name: "Open in Browser Split" }).click();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect.poll(() => webviewSrcs(window)).toEqual([url]);
  await expect(window.locator(`[data-pane-id="${paneId}"] [data-testid="terminal-pane"]`)).toBeVisible();
  await window.waitForTimeout(1_500);
  await window.screenshot({ path: shot(testInfo, "browser-split-light") });

  // Open in New Browser Tab: a new tab, selected, showing the link.
  const tabsBefore = await window.locator('[data-testid="tab"]').count();
  await rightClickText(window, paneId, url);
  await menu(window).getByRole("menuitem", { name: "Open in New Browser Tab" }).click();
  await expect(window.locator('[data-testid="tab"]')).toHaveCount(tabsBefore + 1);
  await expect(window.locator('[data-testid="tab"][aria-selected="true"]')).toHaveCount(1);
  await expect.poll(() => webviewSrcs(window)).toEqual([url]);
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(1);
  await window.waitForTimeout(1_500);
  await window.screenshot({ path: shot(testInfo, "browser-tab-light") });
});

test("an OSC 8 hyperlink offers its target, and plain text offers no link items", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(120_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-osc8");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);

  const url = `${base}/osc8-target`;
  await runInTerminal(window, `printf '\\033]8;;${url}\\033\\\\Read the docs\\033]8;;\\033\\\\\\n'`);
  await expect.poll(() => paneText(window, paneId)).toMatch(lineStarting("Read the docs"));

  await rightClickText(window, paneId, "Read the docs");
  const items = menu(window).locator('[role="menuitem"]');
  for (const [i, name] of LINK_ITEMS.entries()) {
    await expect(items.nth(i)).toContainText(name);
  }
  await window.screenshot({ path: shot(testInfo, "osc8-menu-dark") });
  await menu(window).getByRole("menuitem", { name: "Copy Link" }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);

  // Plain text: the terminal's menu as it was, with no link items.
  await runInTerminal(window, "echo just some words");
  await expect.poll(() => paneText(window, paneId)).toMatch(lineStarting("just some words"));
  await rightClickText(window, paneId, "just some words");
  await expect(menu(window).getByRole("menuitem", { name: "Paste" })).toBeVisible();
  for (const name of LINK_ITEMS) {
    await expect(menu(window).getByRole("menuitem", { name })).toHaveCount(0);
  }
  await window.screenshot({ path: shot(testInfo, "plain-text-menu-dark") });
  await closeMenu(window);
});
