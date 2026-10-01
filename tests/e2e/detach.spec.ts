import type { ElectronApplication, Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import { layout } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { closeSettings, enableRemoteControl, pairDevice } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal, scrollback } from "./helpers/terminal";

/**
 * A detached window is a claim, not a hand-off (ADR-179 D4).
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

/** Click a native menu item by its label path, as macOS would. */
function clickMenuItem(
  app: ElectronApplication,
  labels: string[],
): Promise<void> {
  return app.evaluate(({ Menu, BrowserWindow }, path) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let item: Electron.MenuItem | undefined;
    for (const label of path) {
      item = items.find((candidate) => candidate.label === label);
      if (!item) throw new Error(`Menu item not found: ${path.join(" › ")}`);
      items = item.submenu?.items ?? [];
    }
    item!.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
  }, labels);
}

/** Right-click a tab and pop it into a window of its own. */
async function detachTab(window: Page, index: number): Promise<void> {
  await tabs(window).nth(index).click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to New Window" }).click();
}

test("a tab popped into its own window is still the workspace's", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "detach-workspace");

  // Two tabs, so the primary still has something to show afterwards.
  await window.keyboard.press("Meta+t");
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  const detachedTabId = await tabs(window).nth(1).getAttribute("data-tab-id");
  expect(detachedTabId).toBeTruthy();

  const popup = await Promise.all([
    app.waitForEvent("window"),
    detachTab(window, 1),
  ]).then(([win]) => win);
  await popup.waitForLoadState("domcontentloaded");

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
  await window.keyboard.press("Meta+d");
  await assertVisiblePaneCount(window, 2);
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);

  // "Move Pane to New Window" is two steps now (ADR-179 D4): the pane becomes
  // a tab of the workspace — a command, so every renderer sees it — and the
  // new window claims that tab.
  const popup = await Promise.all([
    app.waitForEvent("window"),
    clickMenuItem(app, ["Pane", "Move Pane to New Window"]),
  ]).then(([win]) => win);
  await popup.waitForLoadState("domcontentloaded");

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
 * A browser is never a claimant (D4): it always sees the whole workspace,
 * including a tab that is popped out on the desk right now, and can type
 * into it — the ADR-179 D7 half of the property `GET /panes` already pins
 * above.
 */
test("a browser still sees and can type into a tab popped out on the desk", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "detach-browser-ws");

  await window.keyboard.press("Meta+t");
  await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
  const detachedTabId = await tabs(window).nth(1).getAttribute("data-tab-id");
  expect(detachedTabId).toBeTruthy();
  const detachedPaneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, detachedPaneId);

  const port = await enableRemoteControl(window);
  const device = await pairDevice(window, {
    label: "detach browser",
    capability: "full",
  });
  await closeSettings(window);

  const client = await openWebApp(port, device.token);
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
    await popup.waitForLoadState("domcontentloaded");
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
