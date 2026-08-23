import type { Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  test,
} from "./fixtures";

/**
 * Terminals for every workspace stay mounted at all times so their PTYs keep
 * running and — critically — keep their exact pixel size. A workspace switch
 * that unmounts, re-parents, or resizes a terminal sends a SIGWINCH, and
 * full-screen TUIs repaint their whole frame into the scrollback on SIGWINCH,
 * which shows up as output duplicated over and over.
 *
 * Keeping them all mounted means they are also all stacked on top of each
 * other, so "exactly one is visible" is the load-bearing invariant here.
 */

/** Click a workspace in the sidebar by its display name. */
async function switchToWorkspace(window: Page, name: string): Promise<void> {
  await window
    .locator('[data-testid="workspace-item"]', { hasText: name })
    .first()
    .click();
}

/** data-pane-id of every currently visible workspace pane. */
async function visiblePaneIds(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="workspace-pane"]:visible')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-pane-id") ?? ""),
    );
}

test("switching workspaces keeps every terminal mounted but only one visible", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-alpha");
  const alphaPanes = await visiblePaneIds(window);
  expect(alphaPanes).toHaveLength(1);

  await createWorkspace(window, "ws-beta");
  await window.keyboard.press("Meta+t");
  // Both workspaces' terminals are mounted now, so wait on the *visible* one —
  // `.first()` would resolve to ws-alpha's pane, which is correctly hidden.
  await expect(
    window.locator('[data-testid="terminal-pane"]:visible'),
  ).toHaveCount(1, { timeout: 30_000 });
  await assertVisiblePaneCount(window, 1);

  const betaPanes = await visiblePaneIds(window);
  expect(betaPanes).toHaveLength(1);
  // A different workspace must show a different terminal. If every workspace
  // renders the same screen, this is where it shows up.
  expect(betaPanes[0]).not.toBe(alphaPanes[0]);

  // Both workspaces' terminals are still in the DOM — that is the keep-alive
  // property the no-SIGWINCH fix depends on.
  await expect
    .poll(() => window.locator('[data-testid="workspace-pane"]').count())
    .toBe(2);

  // Switch back and forth: exactly one pane visible each time, and it is the
  // one belonging to the workspace we selected.
  for (let i = 0; i < 3; i++) {
    await switchToWorkspace(window, "ws-alpha");
    await expect.poll(() => visiblePaneIds(window)).toEqual(alphaPanes);

    await switchToWorkspace(window, "ws-beta");
    await expect.poll(() => visiblePaneIds(window)).toEqual(betaPanes);
  }

  // Still mounted after all that switching — nothing was torn down.
  await expect
    .poll(() => window.locator('[data-testid="workspace-pane"]').count())
    .toBe(2);
});

test("switching tabs within a workspace shows only the selected tab", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-tabs");
  const firstTabPanes = await visiblePaneIds(window);
  expect(firstTabPanes).toHaveLength(1);

  await window.keyboard.press("Meta+t");
  await assertVisiblePaneCount(window, 1);
  const secondTabPanes = await visiblePaneIds(window);
  expect(secondTabPanes).toHaveLength(1);
  expect(secondTabPanes[0]).not.toBe(firstTabPanes[0]);

  const tabs = window.locator('[data-testid="tab"]');
  await expect.poll(() => tabs.count()).toBe(2);

  await tabs.nth(0).click();
  await expect.poll(() => visiblePaneIds(window)).toEqual(firstTabPanes);

  await tabs.nth(1).click();
  await expect.poll(() => visiblePaneIds(window)).toEqual(secondTabPanes);
});
