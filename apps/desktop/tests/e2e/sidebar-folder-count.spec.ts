import type { Page } from "@playwright/test";
import { expect, importSeededProject, test } from "./fixtures";

/**
 * A folder header counts the workspaces in its whole subtree, in the header's
 * chip, whether the folder is open or collapsed.
 */

const SHOTS = process.env.MANOR_E2E_SHOTS;

async function shot(window: Page, name: string): Promise<void> {
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

const folderCount = (window: Page, name: string) =>
  folderHeader(window, name).getByTestId("folder-workspace-count");

async function newFolderFromWorkspace(window: Page, wsName: string, folderName: string) {
  await row(window, wsName).click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to Folder" }).hover();
  await window.getByRole("menuitem", { name: "New Folder…" }).click();
  await window.getByPlaceholder("Folder name").fill(folderName);
  await window.getByRole("button", { name: "Create", exact: true }).click();
  await expect(folderHeader(window, folderName)).toBeVisible({ timeout: 10_000 });
}

test("a folder header counts the workspaces in its subtree", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await importSeededProject(app, window, tempHome);
  for (const name of ["ws-a", "ws-b", "ws-c"]) {
    await createWorkspace(window, name);
  }
  await expect(window.getByTestId("workspace-item")).toHaveCount(4, { timeout: 30_000 });

  // One workspace: the singular, in the tooltip.
  await newFolderFromWorkspace(window, "ws-a", "outer");
  await expect(folderCount(window, "outer")).toHaveText("1");
  await expect(folderCount(window, "outer")).toHaveAttribute("title", "1 workspace");

  // A second member moves the count.
  await row(window, "ws-b").click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to Folder" }).hover();
  await window.getByRole("menuitem", { name: "outer", exact: true }).click();
  await expect(folderCount(window, "outer")).toHaveText("2");
  await expect(folderCount(window, "outer")).toHaveAttribute("title", "2 workspaces");

  // A subfolder's workspaces count towards its parent too.
  await folderHeader(window, "outer").click({ button: "right" });
  await window.getByRole("menuitem", { name: "New Folder Inside…" }).click();
  await window.getByPlaceholder("Folder name").fill("inner");
  await window.getByRole("button", { name: "Create", exact: true }).click();
  await expect(folderCount(window, "inner")).toHaveText("0");
  await row(window, "ws-c").click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to Folder" }).hover();
  await window.getByRole("menuitem", { name: "outer / inner" }).click();
  await expect(folderCount(window, "inner")).toHaveText("1");
  await expect(folderCount(window, "outer")).toHaveText("3");
  await shot(window, "folder-count-expanded");

  // Collapsing keeps the count on the header.
  await folderHeader(window, "outer").click();
  await expect(folderHeader(window, "outer")).toHaveAttribute("aria-expanded", "false");
  await expect(folderCount(window, "outer")).toHaveText("3");
  await shot(window, "folder-count-collapsed");
});
