import type { Locator, Page } from "@playwright/test";
import { expect, importSeededProject, test } from "./fixtures";

/**
 * Sidebar multi-select (ADR-190): shift-click a range, Cmd/Ctrl-click to
 * toggle, act on the selection from its context menu, and drag it as one
 * block into and out of a folder.
 */

const SHOTS = process.env.MANOR_E2E_SHOTS;
/** While recording, hold on each step long enough for a person to follow. */
const PACE = process.env.MANOR_E2E_VIDEO ? 900 : 0;

async function shot(window: Page, name: string): Promise<void> {
  if (PACE) await window.waitForTimeout(PACE);
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function createWorkspace(window: Page, name: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+n");
  const dialog = window.getByTestId("new-workspace-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window.getByTestId("new-workspace-name-input").fill(name);
  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog).not.toBeVisible({ timeout: 20_000 });
}

const row = (window: Page, name: string) =>
  window.getByTestId("workspace-item").filter({ hasText: name });

const folderHeader = (window: Page, name: string) =>
  window
    .locator("[data-sidebar-row][aria-expanded]:not([data-testid])")
    .filter({ hasText: name });

/** Names of the rows marked selected, in DOM order. */
const selectedNames = (window: Page) =>
  window
    .locator('[data-testid="workspace-item"][aria-selected="true"] [data-testid="workspace-name"]')
    .allInnerTexts();

/** Pointer drag with intermediate moves, so the sidebar's 4px threshold and
 * per-move hit testing both run. */
async function drag(
  window: Page,
  from: Locator,
  to: Locator,
  at: "middle" | "below",
  midShot?: string,
): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const x = a.x + a.width / 2;
  const startY = a.y + a.height / 2;
  // The hook hit-tests the dragged row's leading edge, not the pointer: an
  // "into" drop needs that edge in the middle of the folder header.
  const endY =
    at === "middle"
      ? startY + (b.y + b.height / 2 - a.y)
      : b.y + b.height * 0.9;
  await window.mouse.move(x, startY);
  await window.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await window.mouse.move(x, startY + ((endY - startY) * i) / steps);
    if (PACE) await window.waitForTimeout(40);
  }
  if (midShot) await shot(window, midShot);
  await window.mouse.up();
}

test("multi-select: range, toggle, bulk menu, and group drag", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await importSeededProject(app, window, tempHome);
  for (const name of ["ws-a", "ws-b", "ws-c", "ws-d"]) {
    await createWorkspace(window, name);
  }
  await expect(window.getByTestId("workspace-item")).toHaveCount(5, {
    timeout: 30_000,
  });

  // ── Shift-click range, Cmd/Ctrl-click toggle ──────────────────────────
  await row(window, "ws-a").click();
  await row(window, "ws-c").click({ modifiers: ["Shift"] });
  await expect.poll(() => selectedNames(window)).toEqual(["ws-a", "ws-b", "ws-c"]);
  await shot(window, "01-shift-range");

  await row(window, "ws-b").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => selectedNames(window)).toEqual(["ws-a", "ws-c"]);
  await row(window, "ws-b").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => selectedNames(window)).toEqual(["ws-a", "ws-b", "ws-c"]);

  // ── Bulk menu → Move to Folder → New Folder… ─────────────────────────
  await row(window, "ws-b").click({ button: "right" });
  await expect(window.getByText("3 workspaces selected")).toBeVisible();
  await shot(window, "02-bulk-menu");
  await window.getByRole("menuitem", { name: "Move to Folder" }).hover();
  await window.getByRole("menuitem", { name: "New Folder…" }).click();
  await window.getByPlaceholder("Folder name").fill("grp");
  await window.getByRole("button", { name: "Create", exact: true }).click();
  await expect(folderHeader(window, "grp")).toContainText("3", { timeout: 10_000 });
  await expect.poll(() => selectedNames(window)).toEqual([]);
  await shot(window, "03-new-folder-with-three");

  // ── Drag two out of the folder, below ws-d ───────────────────────────
  await row(window, "ws-a").click();
  await row(window, "ws-b").click({ modifiers: ["Shift"] });
  await expect.poll(() => selectedNames(window)).toEqual(["ws-a", "ws-b"]);
  await drag(window, row(window, "ws-a"), row(window, "ws-d"), "below", "04-drag-out-midway");
  await expect(folderHeader(window, "grp")).toContainText("1", { timeout: 10_000 });
  const order = await window.getByTestId("workspace-name").allInnerTexts();
  expect(order.slice(-2)).toEqual(["ws-a", "ws-b"]);
  await shot(window, "05-after-drag-out");

  // ── Drag two back into the folder header ─────────────────────────────
  await row(window, "ws-a").click();
  await row(window, "ws-b").click({ modifiers: ["Shift"] });
  await drag(window, row(window, "ws-b"), folderHeader(window, "grp"), "middle", "06-drag-in-midway");
  await expect(folderHeader(window, "grp")).toContainText("3", { timeout: 10_000 });
  await shot(window, "07-after-drag-in");

  // ── Bulk Remove from Folder ──────────────────────────────────────────
  await row(window, "ws-a").click();
  await row(window, "ws-b").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => selectedNames(window)).toEqual(["ws-a", "ws-b"]);
  await row(window, "ws-a").click({ button: "right" });
  await expect(window.getByText("2 workspaces selected")).toBeVisible();
  await shot(window, "07b-remove-menu");
  await window.getByRole("menuitem", { name: "Remove from Folder" }).click();
  await expect(folderHeader(window, "grp")).toContainText("1", { timeout: 10_000 });

  // ── Bulk hide ────────────────────────────────────────────────────────
  await row(window, "ws-a").click();
  await row(window, "ws-b").click({ modifiers: ["ControlOrMeta"] });
  await row(window, "ws-a").click({ button: "right" });
  await window.getByRole("menuitem", { name: "Hide 2 Workspaces" }).click();
  await expect(row(window, "ws-a")).toHaveCount(0, { timeout: 10_000 });
  await expect(row(window, "ws-b")).toHaveCount(0);
  await shot(window, "08-after-hide");

  // ── Bulk delete ──────────────────────────────────────────────────────
  await row(window, "ws-c").click();
  await row(window, "ws-d").click({ modifiers: ["ControlOrMeta"] });
  await row(window, "ws-d").click({ button: "right" });
  await window.getByRole("menuitem", { name: "Delete 2 Workspaces…" }).click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toContainText("ws-c");
  await expect(dialog).toContainText("ws-d");
  await shot(window, "09-bulk-delete-dialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row(window, "ws-c")).toHaveCount(0, { timeout: 60_000 });
  await expect(row(window, "ws-d")).toHaveCount(0, { timeout: 60_000 });
  await expect(window.getByTestId("workspace-item")).toHaveCount(1);
  await shot(window, "10-after-delete");
});
