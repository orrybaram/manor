import type { Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";

/** Right-click the active tab and select "Duplicate Tab" from the context menu. */
async function duplicateActiveTab(window: Page): Promise<void> {
  const activeTab = window.locator('[data-testid="tab"][aria-selected="true"]');
  await expect(activeTab).toBeVisible();
  await activeTab.click({ button: "right" });
  // Radix renders the context menu in a portal outside the tab subtree.
  await window.getByRole("menuitem", { name: "Duplicate Tab" }).click();
}

test("duplicating a tab with a horizontal pane split preserves both panes", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "dup-tab-workspace");

  // split-h (Cmd+D): side-by-side split of the focused pane.
  await window.keyboard.press("Meta+d");
  await assertVisiblePaneCount(window, 2);

  const sourceTabId = await window
    .locator('[data-testid="tab"][aria-selected="true"]')
    .getAttribute("data-tab-id");
  expect(sourceTabId).toBeTruthy();

  await duplicateActiveTab(window);

  const newTabId = await window
    .locator('[data-testid="tab"][aria-selected="true"]')
    .getAttribute("data-tab-id");
  expect(newTabId).toBeTruthy();
  expect(newTabId).not.toBe(sourceTabId);

  await assertVisiblePaneCount(window, 2);
});

test("duplicating a tab with a vertical pane split preserves both panes", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "dup-tab-workspace");

  // split-v (Cmd+Shift+D): stacked split of the focused pane.
  await window.keyboard.press("Meta+Shift+d");
  await assertVisiblePaneCount(window, 2);

  await duplicateActiveTab(window);
  await assertVisiblePaneCount(window, 2);
});

test("duplicating a tab with nested splits preserves every pane", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "dup-tab-workspace");

  await window.keyboard.press("Meta+d");
  await assertVisiblePaneCount(window, 2);
  await window.keyboard.press("Meta+Shift+d");
  await assertVisiblePaneCount(window, 3);

  await duplicateActiveTab(window);
  await assertVisiblePaneCount(window, 3);
});
