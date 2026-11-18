import type { Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import { layout } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal, scrollback } from "./helpers/terminal";
import { clickMenuItem, waitForAppDocument } from "./helpers/window";

/**
 * A detached window is a claim, not a hand-off.
 *
 * The property this pins is the one the old design could not have: the tab is
 * still *in the workspace* the whole time it is popped out. The primary stops
 * drawing it, the popout draws it, and the server — `GET /panes`, which is
 * what MCP and the CLI see, and what a browser mirrors — lists it either way.
 * Closing the popout releases the claim and the tab reappears where it was,
 * with no payload to ferry and no session to re-attach.
 */

function tabs(window: Page) {
  return window.locator('[data-testid="tab"]');
}

/** Right-click a tab and pop it into a window of its own. */
async function detachTab(window: Page, index: number): Promise<void> {
  await tabs(window).nth(index).click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to New Window" }).click();
}

test("a tab popped into its own window is still the workspace's", { tag: "@smoke" }, async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "detach-workspace");

  // Two tabs, so the primary still has something to show afterwards.
  await window.keyboard.press("ControlOrMeta+t");
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  const detachedTabId = await tabs(window).nth(1).getAttribute("data-tab-id");
  expect(detachedTabId).toBeTruthy();

  const popup = await Promise.all([
    app.waitForEvent("window"),
    detachTab(window, 1),
  ]).then(([win]) => win);
  await waitForAppDocument(popup);

  // The primary hides it because the popout reported a claim on it…
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);
  await expect(tabs(window).first()).not.toHaveAttribute(
    "data-tab-id",
    detachedTabId!,
  );

  // …the popout shows that one tab and nothing else…
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(1);
  await expect(tabs(popup).first()).toHaveAttribute(
    "data-tab-id",
    detachedTabId!,
  );

  // …and the workspace still has both, which is the whole point: nothing
  // moved, so MCP, the CLI and a browser all go on seeing the tab.
  const snapshot = await layout(request, tempHome);
  expect(snapshot.tabs.map((t) => t.tabId)).toContain(detachedTabId);
  expect(snapshot.tabs).toHaveLength(2);

  // Closing the window releases the claim; the tab comes back on its own.
  await popup.close();
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  expect(
    await Promise.all(
      (await tabs(window).all()).map((t) => t.getAttribute("data-tab-id")),
    ),
  ).toContain(detachedTabId);
});

test("a pane popped out becomes a tab of the workspace, not a copy of one", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "detach-pane-ws");
  await window.keyboard.press("ControlOrMeta+d");
  await assertVisiblePaneCount(window, 2);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);

  // "Move Pane to New Window" is two steps now: the pane becomes
  // a tab of the workspace — a command, so every renderer sees it — and the
  // new window claims that tab.
  const popup = await Promise.all([
    app.waitForEvent("window"),
    clickMenuItem(app, ["Pane", "Move Pane to New Window"]),
  ]).then(([win]) => win);
  await waitForAppDocument(popup);

  // The split collapsed here and the popout shows the pane that left.
  await assertVisiblePaneCount(window, 1);
  await assertVisiblePaneCount(popup, 1);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);

  // Two tabs on the server: the popped-out pane is a tab of this workspace,
  // which is what a browser and `list_panes` see.
  await expect
    .poll(async () => (await layout(request, tempHome)).tabs.length, {
      timeout: 30_000,
    })
    .toBe(2);

  // And closing the window hands it back as a tab of the primary.
  await popup.close();
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
});

/**
 * A browser is never a claimant: it always sees the whole workspace,
 * including a tab that is popped out on the desk right now, and can type
 * into it — the browser's half of the property `GET /panes` already pins
 * above. Through a local relay, the only road a browser has.
 */
relayTest("a browser still sees and can type into a tab popped out on the desk", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "detach-browser-ws");

  await window.keyboard.press("ControlOrMeta+t");
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  const detachedTabId = await tabs(window).nth(1).getAttribute("data-tab-id");
  expect(detachedTabId).toBeTruthy();
  const detachedPaneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, detachedPaneId);

  const device = await pairBrowser(window, { label: "detach browser" });
  await closeSettings(window);

  const client = await openWebApp(device.link);
  try {
    await expect(
      client.page.getByTestId("workspace-item").filter({
        hasText: "detach-browser-ws",
      }),
    ).toBeVisible({ timeout: 30_000 });

    const popup = await Promise.all([
      app.waitForEvent("window"),
      detachTab(window, 1),
    ]).then(([win]) => win);
    await waitForAppDocument(popup);
    await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);

    // Still two tabs on the server, and the browser still lists both —
    // the primary hides a claimed tab, a browser never does.
    const snapshot = await layout(request, tempHome);
    expect(snapshot.tabs.map((t) => t.tabId)).toContain(detachedTabId);
    await expect
      .poll(() => tabs(client.page).count(), { timeout: 15_000 })
      .toBe(2);

    await client.page.locator(`[data-tab-id="${detachedTabId}"]`).click();
    await expect
      .poll(() => activePaneId(client.page), { timeout: 10_000 })
      .toBe(detachedPaneId);

    const message = "hello from the browser, tab is popped out";
    await runInTerminal(client.page, message);
    await expect
      .poll(() => scrollback(tempHome, detachedPaneId), { timeout: 15_000 })
      .toContain(message);

    await popup.close();
    await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  } finally {
    await client.close();
  }
});

/** Where the multi-tab specs save their screenshots, when asked to. */
const SHOTS = process.env.MANOR_DETACH_SHOTS;

/**
 * Count the primary's tabs on every DOM change from here on, so a tab that
 * shows for one frame and leaves again is still caught.
 */
async function watchTabCount(window: Page): Promise<() => Promise<number>> {
  await window.evaluate(() => {
    const w = window as unknown as { __maxTabs: number };
    const count = () => document.querySelectorAll('[data-testid="tab"]').length;
    w.__maxTabs = count();
    new MutationObserver(() => {
      w.__maxTabs = Math.max(w.__maxTabs, count());
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () =>
    window.evaluate(() => (window as unknown as { __maxTabs: number }).__maxTabs);
}

/** Boot with two tabs and pop the second out; the popout holds one tab. */
async function popOutSecondTab(
  app: Parameters<typeof bootWorkspaceWithTerminal>[0],
  window: Page,
  tempHome: string,
  name: string,
): Promise<Page> {
  await bootWorkspaceWithTerminal(app, window, tempHome, name);
  await window.keyboard.press("ControlOrMeta+t");
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  const popup = await Promise.all([
    app.waitForEvent("window"),
    detachTab(window, 1),
  ]).then(([win]) => win);
  await waitForAppDocument(popup);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(1);
  return popup;
}

/** Right-click a tab of a popout and send it back to the primary. */
async function moveTabBack(popup: Page, index: number): Promise<void> {
  await tabs(popup).nth(index).click({ button: "right" });
  await popup.getByRole("menuitem", { name: "Move Back to Main Window" }).click();
}

test("a tab made in a popped-out window stays in that window", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  const popup = await popOutSecondTab(app, window, tempHome, "detach-new-tab-ws");
  const maxPrimaryTabs = await watchTabCount(window);

  // The + button…
  await popup.getByRole("button", { name: "New tab" }).click();
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(2);

  // …and the shortcut, with the popout focused.
  await popup.bringToFront();
  await popup.keyboard.press("ControlOrMeta+t");
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(3);

  // The server holds all four; the primary never drew either new one, not
  // even for a frame.
  await expect
    .poll(async () => (await layout(request, tempHome)).tabs.length, { timeout: 30_000 })
    .toBe(4);
  expect(await tabs(window).count()).toBe(1);
  expect(await maxPrimaryTabs()).toBe(1);

  if (SHOTS) {
    await popup.screenshot({ path: `${SHOTS}/popout-three-tabs.png` });
    await window.screenshot({ path: `${SHOTS}/primary-one-tab.png` });
  }

  // Move Back on one tab sends just that one; the popout keeps the rest.
  await moveTabBack(popup, 0);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(2);
  expect(popup.isClosed()).toBe(false);

  if (SHOTS) {
    await popup.screenshot({ path: `${SHOTS}/popout-after-move-back.png` });
    await window.screenshot({ path: `${SHOTS}/primary-after-move-back.png` });
  }

  // Closing the window gives back every tab it still holds.
  await popup.close();
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(4);
});

test("a popped-out window closes when it sends back its last tab", async ({
  app,
  window,
  tempHome,
}) => {
  const popup = await popOutSecondTab(app, window, tempHome, "detach-last-tab-ws");
  await popup.getByRole("button", { name: "New tab" }).click();
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(2);

  await moveTabBack(popup, 1);
  await expect.poll(() => tabs(popup).count(), { timeout: 30_000 }).toBe(1);
  expect(popup.isClosed()).toBe(false);

  await Promise.all([popup.waitForEvent("close"), moveTabBack(popup, 0)]);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(3);
});
