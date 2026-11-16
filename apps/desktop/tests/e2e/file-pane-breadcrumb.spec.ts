import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane, treeRow } from "./helpers/file-pane";

/**
 * The file pane's breadcrumb (#690): each segment opens a picker of its
 * folder's entries, read off the cached `files.list`. Type to narrow, Enter
 * opens a file or steps into a folder, ← or Backspace steps out, Escape or a
 * click outside closes it, and Reveal in Files shows the folder in the tree.
 */

const LIGHT_THEME = "E2E Light";

function installLightTheme(tempHome: string): void {
  const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
  fs.mkdirSync(dir, { recursive: true });
  const palette = [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ];
  fs.writeFileSync(
    path.join(dir, LIGHT_THEME),
    [
      ...palette.map((c, i) => `palette = ${i}=${c}`),
      "background = #ffffff",
      "foreground = #1f2328",
      "cursor-color = #0969da",
      "selection-background = #dbe9f9",
      "selection-foreground = #1f2328",
      "",
    ].join("\n"),
  );
}

const crumb = (window: Page, index: number) =>
  pane(window).locator(`[data-testid="file-pane-crumb-${index}"]`);
const picker = (window: Page) => window.locator('[data-testid="breadcrumb-picker"]');
const filter = (window: Page) => window.locator('[data-testid="breadcrumb-picker-filter"]');
const entries = (window: Page) =>
  picker(window).locator('[data-testid="breadcrumb-picker-entry"]');
const cursorEntry = (window: Page) =>
  picker(window).locator('[data-testid="breadcrumb-picker-entry"][aria-selected="true"]');
const pickerPath = (window: Page) => window.locator('[data-testid="breadcrumb-picker-path"]');

test("breadcrumb segments open a folder picker that filters, drills in, opens files and reveals folders", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-crumbs");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  };
  write("src/components/Widget.tsx", "export const widget = 1;\n");
  write("src/components/Zed.tsx", "export const zed = 2;\n");
  write("src/lib/util.ts", "export const util = 3;\n");
  write("src/lib/deep/inner.ts", "export const inner = 4;\n");
  write("README.md", "# readme\n");

  await openFileFromPalette(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  const breadcrumb = pane(window).locator('[data-testid="file-pane-breadcrumb"]');
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(editor).toContainText("export const widget");
  // Shut the drawer, so Reveal in Files has to open it.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer).toBeHidden();

  // The file's segment lists its own folder, filter focused, on the open file.
  await crumb(window, 2).click();
  await expect(picker(window)).toBeVisible();
  await expect(pickerPath(window)).toHaveText("src/components/");
  await expect(filter(window)).toBeFocused();
  await expect(entries(window)).toHaveText(["Widget.tsx", "Zed.tsx"]);
  await expect(cursorEntry(window)).toHaveAttribute("data-path", "src/components/Widget.tsx");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("picker-dark.png") });

  // Typing narrows; Enter opens the file in this pane, and the editor takes the keyboard.
  await window.keyboard.type("ze");
  await expect(entries(window)).toHaveText(["Zed.tsx"]);
  await window.keyboard.press("Enter");
  await expect(picker(window)).toBeHidden();
  await expect(editor).toContainText("export const zed");
  await expect(breadcrumb).toContainText("Zed.tsx");
  await expect(editor.locator(".cm-content")).toBeFocused();

  // A folder's segment lists that folder, folders first, on the way to the open file.
  await crumb(window, 0).click();
  await expect(pickerPath(window)).toHaveText("src/");
  await expect(entries(window)).toHaveText(["components", "lib"]);
  await expect(entries(window).first()).toHaveAttribute("data-kind", "dir");
  await expect(cursorEntry(window)).toHaveAttribute("data-path", "src/components");
  // ↓ then Enter steps into lib, in the same picker.
  await window.keyboard.press("ArrowDown");
  await expect(cursorEntry(window)).toHaveAttribute("data-path", "src/lib");
  await window.keyboard.press("Enter");
  await expect(pickerPath(window)).toHaveText("src/lib/");
  await expect(entries(window)).toHaveText(["deep", "util.ts"]);
  await expect(filter(window)).toBeFocused();
  // Backspace on the empty filter steps back out, onto the folder left.
  await window.keyboard.press("Backspace");
  await expect(pickerPath(window)).toHaveText("src/");
  await expect(cursorEntry(window)).toHaveAttribute("data-path", "src/lib");
  // ← steps out to the workspace's root, and no further.
  await window.keyboard.press("ArrowLeft");
  await expect(pickerPath(window)).toHaveText("./");
  await expect(entries(window)).toHaveText(["src", "README.md"]);
  await window.keyboard.press("ArrowLeft");
  await expect(pickerPath(window)).toHaveText("./");
  // A click on a folder steps in; a click on a file opens it.
  await entries(window).filter({ hasText: "src" }).click();
  await entries(window).filter({ hasText: "lib" }).click();
  await entries(window).filter({ hasText: "util.ts" }).click();
  await expect(picker(window)).toBeHidden();
  await expect(editor).toContainText("export const util");

  // Escape closes the picker and hands the keyboard back to its segment.
  await crumb(window, 1).click();
  await expect(pickerPath(window)).toHaveText("src/lib/");
  await window.keyboard.press("Escape");
  await expect(picker(window)).toBeHidden();
  await expect(crumb(window, 1)).toBeFocused();
  await expect(editor).toContainText("export const util");

  // A click outside closes it too.
  await crumb(window, 0).click();
  await expect(picker(window)).toBeVisible();
  await editor.locator(".cm-content").click();
  await expect(picker(window)).toBeHidden();

  // Reveal in Files opens the drawer on the folder, expanded and in view.
  await crumb(window, 2).click();
  await expect(pickerPath(window)).toHaveText("src/lib/");
  await window.keyboard.type("deep");
  await window.keyboard.press("Enter");
  await expect(pickerPath(window)).toHaveText("src/lib/deep/");
  await window.locator('[data-testid="breadcrumb-picker-reveal"]').click();
  await expect(picker(window)).toBeHidden();
  await expect(drawer).toHaveAttribute("data-mode", "files");
  await expect(treeRow(window, "src/lib/deep")).toBeInViewport();
  await expect(treeRow(window, "src/lib/deep/inner.ts")).toBeVisible();
  await expect(pane(window).locator('[data-testid="file-pane-tree"]')).toBeFocused();
  await expect(
    pane(window).locator('[data-testid="file-pane-tree-row"][class*="rowCursor"]'),
  ).toHaveAttribute("data-path", "src/lib/deep");
  await window.screenshot({ path: testInfo.outputPath("revealed-dark.png") });

  // The keyboard reaches Reveal too: ↓ past the last entry lands on it, and stops there.
  await crumb(window, 1).click();
  await expect(pickerPath(window)).toHaveText("src/lib/");
  await expect(cursorEntry(window)).toHaveAttribute("data-path", "src/lib/util.ts");
  for (let i = 0; i < 3; i++) await window.keyboard.press("ArrowDown");
  await expect(cursorEntry(window)).toHaveCount(0);
  await window.keyboard.press("Enter");
  await expect(picker(window)).toBeHidden();
  await expect(
    pane(window).locator('[data-testid="file-pane-tree-row"][class*="rowCursor"]'),
  ).toHaveAttribute("data-path", "src/lib");

  // Light theme: the picker reads on a light background.
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .not.toBe("#1e1e2e");
  await crumb(window, 2).click();
  await expect(picker(window)).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("picker-light.png") });
  await window.keyboard.press("Escape");
});
