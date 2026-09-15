import type { Page } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  expect,
  importSeededProject,
  test,
} from "./fixtures";

/**
 * `:shortcode` emoji autocomplete (ADR-174).
 *
 * The suggestion list has to own Enter, Escape and clicks while it is open,
 * without the field's own handling seeing them: Enter must insert rather than
 * submit the dialog, Escape must close the list rather than cancel an inline
 * rename, and clicking a suggestion must not blur-commit the rename.
 */

const listbox = (window: Page) => window.getByRole("listbox");

test("emoji suggestions in the new workspace dialog insert without submitting", async ({
  app,
  window,
  tempHome,
}) => {
  await importSeededProject(app, window, tempHome);
  await window.keyboard.press("Meta+Shift+n");
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const name = window.locator('[data-testid="new-workspace-name-input"]');

  // Open the list and pick with Enter: inserts, dialog stays open.
  await name.pressSequentially(":tada");
  await expect(listbox(window)).toBeVisible({ timeout: 10_000 });
  await expect(listbox(window).getByRole("option").first()).toContainText("🎉");
  await name.press("Enter");
  await expect(name).toHaveValue("🎉");
  await expect(listbox(window)).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Typing the closing colon completes an exact shortcode in place.
  await name.pressSequentially(" ship :rocket:");
  await expect(name).toHaveValue("🎉 ship 🚀");

  // Times and URLs never open the list.
  await name.fill("");
  await name.pressSequentially("at 10:30");
  await expect(listbox(window)).toHaveCount(0);

  // With the list closed, Escape is the dialog's again.
  await name.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
});

test("emoji suggestions in a textarea open under the line being typed", async ({
  window,
}) => {
  await window.getByRole("button", { name: "Send feedback" }).click();
  const description = window.getByPlaceholder(
    "What happened? What did you expect?",
  );
  await expect(description).toBeVisible({ timeout: 5_000 });

  await description.fill("first line\nsecond line\nthird ");
  await description.pressSequentially(":tad");
  await expect(listbox(window)).toBeVisible({ timeout: 10_000 });

  // Anchored to the third line's `:` — inside the textarea, indented past
  // "third " — rather than below the textarea's bottom-left corner.
  const fieldBox = await description.boundingBox();
  const listBox = await listbox(window).boundingBox();
  expect(listBox!.y).toBeGreaterThan(fieldBox!.y + 40);
  expect(listBox!.y).toBeLessThan(fieldBox!.y + fieldBox!.height);
  expect(listBox!.x).toBeGreaterThan(fieldBox!.x + 30);
});

test("emoji suggestions in the inline workspace rename keep the edit open", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-emoji");
  const byName = window
    .locator('[data-testid="workspace-item"]', { hasText: "ws-emoji" })
    .first();
  await expect(byName.getByTestId("workspace-name")).toHaveText("ws-emoji", {
    timeout: 30_000,
  });
  const wsPath = await byName.getAttribute("data-workspace-path");
  const item = window.locator(
    `[data-testid="workspace-item"][data-workspace-path="${wsPath}"]`,
  );
  const input = item.getByTestId("workspace-name-input");

  await item.press("Enter");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill("");
  await input.pressSequentially("ship :rock");
  await expect(listbox(window)).toBeVisible({ timeout: 10_000 });

  // The list opens at the `:`, not at the field's left edge.
  const inputBox = await input.boundingBox();
  const listBox = await listbox(window).boundingBox();
  expect(listBox!.x).toBeGreaterThan(inputBox!.x + 15);

  // Escape closes only the list; the rename is still in progress.
  await input.press("Escape");
  await expect(listbox(window)).toHaveCount(0);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("ship :rock");

  // Keep typing to reopen, then click a suggestion: no blur commit.
  await input.pressSequentially("et");
  await expect(listbox(window)).toBeVisible({ timeout: 10_000 });
  await listbox(window)
    .getByRole("option")
    .filter({ hasText: ":rocket:" })
    .first()
    .click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("ship 🚀");

  await input.press("Enter");
  await expect(item.getByTestId("workspace-name")).toHaveText("ship 🚀", {
    timeout: 15_000,
  });
});
