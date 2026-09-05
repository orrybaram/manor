import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";

/**
 * The command palette pins the commands a user runs most often at the top of
 * its root view, in a "Frequently Used" group. The group is ranked by how many
 * times each command has been picked, exists only while the search box is
 * empty, and survives a reload because usage is persisted.
 */

const FREQUENT_HEADING = "Frequently Used";

const paletteInput = (window: Page) =>
  window.getByPlaceholder("Type a command...");

const groupHeadings = (window: Page) => window.locator("[cmdk-group-heading]");

const frequentGroup = (window: Page) =>
  window.locator("[cmdk-group]", {
    has: window.locator("[cmdk-group-heading]", {
      hasText: FREQUENT_HEADING,
    }),
  });

async function openPalette(window: Page): Promise<void> {
  await window.keyboard.press("Meta+k");
  await expect(paletteInput(window)).toBeVisible();
}

async function closePalette(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(paletteInput(window)).not.toBeVisible();
}

/** Open the palette, search for `label`, and pick the matching command. */
async function runCommand(window: Page, label: string): Promise<void> {
  await openPalette(window);
  await paletteInput(window).fill(label);
  const item = window.locator("[cmdk-item]", { hasText: label }).first();
  await expect(item).toBeVisible();
  await item.click();
  // Every command in this test closes the palette when it runs.
  await expect(paletteInput(window)).not.toBeVisible();
}

/** Labels of the items in the Frequently Used group, top to bottom. */
async function frequentLabels(window: Page): Promise<string[]> {
  return frequentGroup(window)
    .locator("[cmdk-item]")
    .evaluateAll((els) =>
      // The label is the first text span; shortcuts and badges follow it.
      els.map((el) => el.querySelector("span:not([class*=icon])")?.textContent?.trim() ?? ""),
    );
}

test("frequently used commands rise to the top of the palette", async ({
  app,
  window,
  tempHome,
}) => {
  const film = new Filmstrip("command-palette-frequent");
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-palette");

  // A fresh profile has no usage, so no pinned group.
  await openPalette(window);
  await film.shot(window, "palette-fresh-no-frequent-group");
  await expect(groupHeadings(window).first()).not.toHaveText(FREQUENT_HEADING);
  await expect(frequentGroup(window)).toHaveCount(0);
  await closePalette(window);

  // Use one command twice and another once. Toggle Sidebar is chosen because
  // running it twice leaves the app exactly as it was.
  await runCommand(window, "Toggle Sidebar");
  await runCommand(window, "New Tab");
  await runCommand(window, "Toggle Sidebar");

  // The pinned group appears first, ranked by use count.
  await openPalette(window);
  await expect(groupHeadings(window).first()).toHaveText(FREQUENT_HEADING);
  await expect.poll(() => frequentLabels(window)).toEqual([
    "Toggle Sidebar",
    "New Tab",
  ]);
  await film.shot(window, "palette-frequent-group-pinned");

  // Typing hands ranking over to search; the pinned group gets out of the way
  // so a command is never listed twice.
  await paletteInput(window).fill("new");
  await expect(frequentGroup(window)).toHaveCount(0);
  await expect(
    window.locator("[cmdk-item]", { hasText: "New Tab" }),
  ).toHaveCount(1);
  await film.shot(window, "palette-search-hides-frequent-group");

  // Clearing the search brings it straight back.
  await paletteInput(window).fill("");
  await expect(groupHeadings(window).first()).toHaveText(FREQUENT_HEADING);
  await closePalette(window);

  // Usage is persisted, so it survives the renderer being reloaded.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  // The sidebar listing the workspace is the sign the app has booted again;
  // its terminal pane can come back hidden until a workspace is re-selected,
  // which is beside the point here.
  await expect(
    window.locator('[data-testid="workspace-item"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await openPalette(window);
  await expect(groupHeadings(window).first()).toHaveText(FREQUENT_HEADING);
  await expect.poll(() => frequentLabels(window)).toEqual([
    "Toggle Sidebar",
    "New Tab",
  ]);
  await film.shot(window, "palette-frequent-group-after-reload");
  await closePalette(window);
});
