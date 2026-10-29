import type { Page } from "@playwright/test";

import { expect } from "../fixtures";

/**
 * The file pane (#449), as the specs drive it: the palette's Open File…, its
 * Files drawer, and typing into its editor. Shared by `file-pane.spec.ts` and
 * the remote-host suite.
 */

export const pane = (window: Page) => window.locator('[data-testid="file-pane"]:visible');

const drawer = (window: Page) => pane(window).locator('[data-testid="file-pane-drawer"]');

const editor = (window: Page) => pane(window).locator('[data-testid="file-pane-editor"]');

export const treeRow = (window: Page, p: string) =>
  pane(window).locator(`[data-testid="file-pane-tree-row"][data-path="${p}"]`);

/** The file pane's header (the leaf's own bar, outside the pane body). */
export const header = (window: Page) =>
  window.locator('[data-testid="workspace-pane"]:visible', { has: pane(window) });

/** Open File… from the command palette: a file pane with its Files drawer showing. */
export async function openFileFromPalette(window: Page): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  await expect(pane(window)).toBeVisible();
}

/**
 * Open the Files drawer if it is shut, and expand folders until the file at
 * `segments` has a row. Folders may be collapsed (or compacted into "a/b"), so
 * any folder on the path that is shown gets a click.
 */
export async function revealInTree(window: Page, segments: string[]): Promise<void> {
  if (!(await drawer(window).isVisible())) {
    await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  }
  await expect(drawer(window)).toBeVisible();
  const file = segments.join("/");
  for (let i = 1; i < segments.length; i++) {
    const dir = drawer(window).locator(
      `[data-testid="file-pane-tree-row"][data-kind="dir"][data-path="${segments.slice(0, i).join("/")}"]`,
    );
    if ((await dir.count()) && !(await treeRow(window, file).count())) await dir.first().click();
  }
  await expect(treeRow(window, file)).toBeVisible();
}

/** Pick the file at `segments` in the Files drawer; the drawer closes. */
export async function openFromTree(window: Page, segments: string[]): Promise<void> {
  await revealInTree(window, segments);
  await treeRow(window, segments.join("/")).click();
  await expect(drawer(window)).toBeHidden();
}

/** Click into the editor and type at the end of the file. */
export async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editor(window).locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type(text);
}
