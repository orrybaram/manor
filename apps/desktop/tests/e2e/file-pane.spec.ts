import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The file pane (#449): opened from the palette, it lists the workspace's
 * files in a drawer, minus what .gitignore hides, and shows the one you pick.
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

async function useLightTheme(window: Page): Promise<void> {
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))
    .not.toBe("#1e1e2e");
}

function shot(testInfo: TestInfo, name: string): string {
  return testInfo.outputPath(`${name}.png`);
}

const WIDGET = `import { useState } from "react";

/** A counter, so the editor has something to highlight. */
export function Widget({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  );
}
`;

const pane = (window: Page) => window.locator('[data-testid="file-pane"]:visible');
const treeRow = (window: Page, p: string) =>
  pane(window).locator(`[data-testid="file-pane-tree-row"][data-path="${p}"]`);

async function openFromTree(window: Page, segments: string[]): Promise<void> {
  if (!(await pane(window).locator('[data-testid="file-pane-drawer"]').isVisible())) {
    await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  }
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toBeVisible();
  // Folders may be collapsed (or compacted into "a/b"); click any folder on the path that's shown.
  const file = segments.join("/");
  for (let i = 1; i < segments.length; i++) {
    const dir = drawer.locator(
      `[data-testid="file-pane-tree-row"][data-kind="dir"][data-path="${segments.slice(0, i).join("/")}"]`,
    );
    if ((await dir.count()) && !(await treeRow(window, file).count())) await dir.first().click();
  }
  await treeRow(window, file).click();
  await expect(drawer).toBeHidden();
}

test("the file pane lists the workspace, opens a file and follows it on disk", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-files");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  // Seed the workspace through its own shell, so the files land wherever it lives.
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.mkdirSync(path.join(ws, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET);
  fs.writeFileSync(path.join(ws, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(ws, "big.log"), "x".repeat(3 * 1024 * 1024));

  // Open File… from the palette: a file pane with the Files drawer showing.
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  await expect(pane(window)).toBeVisible();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-testid="file-pane-tree-row"]').first()).toBeVisible();
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "drawer-dark") });

  // .gitignore applies: nothing under node_modules is listed.
  await expect(drawer.locator('[data-testid="file-pane-tree-row"][data-path^="node_modules"]')).toHaveCount(0);

  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("Widget.tsx");
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "editor-dark") });

  // An agent rewrites the open file: the pane follows.
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET.replace("Clicked", "Pressed"));
  await expect(editor).toContainText("Pressed {count} times", { timeout: 10_000 });

  // A file over 2 MB is refused with a message instead of an editor.
  await openFromTree(window, ["big.log"]);
  await expect(pane(window).locator('[data-testid="file-pane-error"]')).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "too-large-dark") });

  await useLightTheme(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  await expect(editor).toContainText("Pressed {count} times");
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "editor-light") });
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "drawer-light") });
});

const OTHER = `export const other = 1;\n`;

/** The file pane's header (the leaf's own bar, outside the pane body). */
const header = (window: Page) =>
  window.locator('[data-testid="workspace-pane"]:visible', { has: pane(window) });

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await pane(window).locator('[data-testid="file-pane-editor"] .cm-content').click();
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type(text);
}

test("the file pane edits, saves, asks before swapping and creates files", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(240_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-file-edit");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  fs.writeFileSync(path.join(ws, "src", "other.ts"), OTHER);
  const onDisk = () => fs.readFileSync(widget, "utf8");

  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  await expect(pane(window)).toBeVisible();
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");

  const dirtyDot = header(window).locator('[data-testid="file-pane-dirty"]');

  // Edit → the dirty dot and the save hint; ⌘S writes it and the dot goes.
  await expect(dirtyDot).toHaveCount(0);
  await typeAtEnd(window, "// first edit");
  await expect(dirtyDot).toBeVisible();
  await expect(header(window).locator('[data-testid="file-pane-save-hint"]')).toContainText("to save");
  await window.screenshot({ path: shot(testInfo, "edit-dirty") });
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(onDisk).toContain("// first edit");
  await expect(dirtyDot).toHaveCount(0);

  // Dirty, pick another file: the swap bar asks; Discard opens it.
  await typeAtEnd(window, "// unsaved");
  await expect(dirtyDot).toBeVisible();
  await openFromTree(window, ["src", "other.ts"]);
  const swap = pane(window).locator('[data-testid="file-pane-swap-bar"]');
  await expect(swap).toBeVisible();
  await expect(swap).toContainText("Unsaved changes to Widget.tsx.");
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("Widget.tsx");
  await window.screenshot({ path: shot(testInfo, "swap-confirm") });
  await swap.locator('[data-testid="file-pane-swap-discard"]').click();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("other.ts");
  await expect(editor).toContainText("export const other = 1;");
  await expect(dirtyDot).toHaveCount(0);
  expect(onDisk()).not.toContain("// unsaved");

  // "+" makes a new file, prefilled with the open file's folder, and opens it.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await drawer.locator('[data-testid="file-pane-new-file"]').click();
  const input = drawer.locator('[data-testid="file-pane-new-file-input"]');
  await expect(input).toHaveValue("src/");
  // One that exists is refused inline.
  await input.fill("src/other.ts");
  await input.press("Enter");
  await expect(drawer.locator('[data-testid="file-pane-new-file-error"]')).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "new-file-exists") });
  // Escape drops the row and keeps the drawer.
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await drawer.locator('[data-testid="file-pane-new-file"]').click();
  await input.fill("src/made/new-file.ts");
  await window.screenshot({ path: shot(testInfo, "new-file-input") });
  await input.press("Enter");
  await expect(drawer).toBeHidden();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("new-file.ts");
  await expect.poll(() => fs.existsSync(path.join(ws, "src", "made", "new-file.ts"))).toBe(true);
  await typeAtEnd(window, "export const made = true;");
  await window.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => fs.readFileSync(path.join(ws, "src", "made", "new-file.ts"), "utf8"))
    .toBe("export const made = true;");
});
