import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * The inline workspace rename in the sidebar: Escape has to abandon the edit,
 * not commit it. The cancel path blurs the input, and the blur handler used
 * to see stale state and commit whatever had been typed.
 */

const workspaceItem = (window: Page, name: string) =>
  window.locator('[data-testid="workspace-item"]', { hasText: name }).first();
const nameOf = (item: ReturnType<Page["locator"]>) =>
  item.getByTestId("workspace-name");
const inputOf = (item: ReturnType<Page["locator"]>) =>
  item.getByTestId("workspace-name-input");
/** Enter on the focused row opens the rename — double-click no longer does
 *  (ADR-172). `press` focuses the row first. */
const startRename = (item: ReturnType<Page["locator"]>) => item.press("Enter");

test("Escape abandons a workspace rename, Enter commits one", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-one");
  const byName = workspaceItem(window, "ws-one");
  await expect(nameOf(byName)).toHaveText("ws-one", { timeout: 30_000 });
  // While editing, the name is an input and the row no longer *contains*
  // the text "ws-one" — so pin the row down by its path, not its label.
  const wsPath = await byName.getAttribute("data-workspace-path");
  const item = window.locator(
    `[data-testid="workspace-item"][data-workspace-path="${wsPath}"]`,
  );

  // Escape: whatever was typed is thrown away.
  await startRename(item);
  await expect(inputOf(item)).toBeVisible({ timeout: 5_000 });
  await expect(inputOf(item)).toHaveValue("ws-one");
  await inputOf(item).fill("not this one");
  await inputOf(item).press("Escape");
  await expect(inputOf(item)).toHaveCount(0);
  await expect(nameOf(item)).toHaveText("ws-one");
  await expect(
    window.locator('[data-testid="workspace-item"]', { hasText: "not this one" }),
  ).toHaveCount(0);

  // Enter still commits, so the guard did not break the happy path.
  await startRename(item);
  await expect(inputOf(item)).toBeVisible({ timeout: 5_000 });
  await inputOf(item).fill("ws-renamed");
  await inputOf(item).press("Enter");
  await expect(nameOf(item)).toHaveText("ws-renamed", { timeout: 15_000 });
});
