import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  modifierClickText,
  paneText,
  rightClickText,
  runInTerminal,
} from "./helpers/terminal";
import {
  header,
  openFileFromPalette,
  openFromTree,
  pane,
  treeRow,
  typeAtEnd,
} from "./helpers/file-pane";

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
  // dist/ proves .gitignore is read: the walk outside git skips
  // node_modules on its own, but not dist.
  fs.writeFileSync(path.join(ws, ".gitignore"), "node_modules/\ndist/\n");
  fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(ws, "dist"), { recursive: true });
  fs.writeFileSync(path.join(ws, "dist", "out.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(ws, "big.log"), "x".repeat(3 * 1024 * 1024));
  // Bytes with a NUL in them: a binary file.
  fs.writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  // Open File… from the palette: a file pane with the Files drawer showing.
  await openFileFromPalette(window);
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-testid="file-pane-tree-row"]').first()).toBeVisible();
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "drawer-dark") });

  // .gitignore applies: nothing under node_modules or dist is listed, though
  // the files beside them are.
  await expect(treeRow(window, "big.log")).toBeVisible();
  await expect(treeRow(window, ".gitignore")).toBeVisible();
  await expect(drawer.locator('[data-testid="file-pane-tree-row"][data-path^="node_modules"]')).toHaveCount(0);
  await expect(drawer.locator('[data-testid="file-pane-tree-row"][data-path^="dist"]')).toHaveCount(0);

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

  // A binary file (a NUL in its first bytes) is refused too, saying why.
  await openFromTree(window, ["blob.bin"]);
  await expect(pane(window).locator('[data-testid="file-pane-error"]')).toContainText(
    "blob.bin is a binary file",
  );
  await expect(pane(window).locator('[data-testid="file-pane-editor"]')).toHaveCount(0);

  await useLightTheme(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  await expect(editor).toContainText("Pressed {count} times");
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "editor-light") });
  await expect(drawer).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "drawer-light") });
});

const OTHER = `export const other = 1;\n`;

test("the file pane edits, saves, asks before swapping, creates files and settles conflicts", async ({
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

  await openFileFromPalette(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");

  const dirtyDot = header(window).locator('[data-testid="file-pane-dirty"]');
  const banner = pane(window).locator('[data-testid="file-pane-conflict"]');

  // Edit → the dirty dot and the save hint; ⌘S writes it and the dot goes.
  await expect(dirtyDot).toHaveCount(0);
  await typeAtEnd(window, "// first edit");
  await expect(dirtyDot).toBeVisible();
  await expect(header(window).locator('[data-testid="file-pane-save-hint"]')).toContainText("to save");
  await window.screenshot({ path: shot(testInfo, "edit-dirty") });
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(onDisk).toContain("// first edit");
  await expect(dirtyDot).toHaveCount(0);
  // Its own save's echo is not a change: no banner, no reload flash.
  await window.waitForTimeout(1_500);
  await expect(banner).toHaveCount(0);

  // Clean, then an agent writes: it reloads silently and says so.
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
  await expect(editor).toContainText("Pressed {count} times", { timeout: 10_000 });
  await expect(header(window).locator('[data-testid="file-pane-reloaded"]')).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "reloaded-from-disk") });

  // Dirty, then an agent writes: the banner; Compare shows disk vs. yours.
  await typeAtEnd(window, "// mine");
  await expect(dirtyDot).toBeVisible();
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Tapped"));
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("An agent changed this file on disk while you were editing.");
  await expect(editor).toContainText("// mine");
  await window.screenshot({ path: shot(testInfo, "conflict-banner") });

  await banner.locator('[data-testid="file-pane-conflict-compare"]').click();
  const compare = pane(window).locator('[data-testid="file-pane-compare"]');
  await expect(compare.locator('[data-testid="file-pane-compare-view"]')).toBeVisible();
  await expect(compare).toContainText("Tapped");
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "compare") });
  await compare.locator('[data-testid="file-pane-compare-back"]').click();
  await expect(compare).toHaveCount(0);

  // Keep mine: the banner goes, the edits stay, and ⌘S overwrites theirs.
  await banner.locator('[data-testid="file-pane-conflict-keep"]').click();
  await expect(banner).toHaveCount(0);
  await expect(dirtyDot).toBeVisible();
  await pane(window).locator('[data-testid="file-pane-editor"] .cm-content').click();
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(onDisk).toContain("// mine");
  expect(onDisk()).not.toContain("Tapped");
  await expect(dirtyDot).toHaveCount(0);

  // Dirty, an agent writes, Reload theirs: the edits go, theirs shows.
  await typeAtEnd(window, "// dropped");
  await expect(dirtyDot).toBeVisible();
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Poked"));
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.locator('[data-testid="file-pane-conflict-reload"]').click();
  await expect(banner).toHaveCount(0);
  await expect(editor).toContainText("Poked {count} times");
  await expect(editor).not.toContainText("// dropped");
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
  // Cancel: the bar goes, and the pane stays on Widget.tsx, still dirty.
  await swap.locator('[data-testid="file-pane-swap-cancel"]').click();
  await expect(swap).toBeHidden();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("Widget.tsx");
  await expect(editor).toContainText("// unsaved");
  await expect(dirtyDot).toBeVisible();
  expect(onDisk()).not.toContain("// unsaved");
  // Ask again, and Discard opens the other file.
  await openFromTree(window, ["src", "other.ts"]);
  await expect(swap).toBeVisible();
  await swap.locator('[data-testid="file-pane-swap-discard"]').click();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("other.ts");
  await expect(editor).toContainText("export const other = 1;");
  await expect(dirtyDot).toHaveCount(0);
  expect(onDisk()).not.toContain("// unsaved");

  // Save and open: the edits reach the disk first, then the other file opens.
  const otherOnDisk = () => fs.readFileSync(path.join(ws, "src", "other.ts"), "utf8");
  await typeAtEnd(window, "// saved on swap");
  await expect(dirtyDot).toBeVisible();
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  await expect(swap).toBeVisible();
  await expect(swap).toContainText("Unsaved changes to other.ts.");
  await swap.locator('[data-testid="file-pane-swap-save"]').click();
  await expect.poll(otherOnDisk).toContain("// saved on swap");
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("Widget.tsx");
  await expect(editor).toContainText("Poked {count} times");
  await expect(swap).toBeHidden();
  await expect(dirtyDot).toHaveCount(0);
  // Back on other.ts (clean, so no bar) for the new-file steps below.
  await openFromTree(window, ["src", "other.ts"]);
  await expect(editor).toContainText("// saved on swap");

  // "+" makes a new file, prefilled with the open file's folder, and opens it.
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
  await expect(input).toHaveCount(0);
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("new-file.ts");
  await expect.poll(() => fs.existsSync(path.join(ws, "src", "made", "new-file.ts"))).toBe(true);
  await typeAtEnd(window, "export const made = true;");
  await window.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => fs.readFileSync(path.join(ws, "src", "made", "new-file.ts"), "utf8"))
    .toBe("export const made = true;");
});

test("the file pane asks before converting or closing over unsaved edits, and a narrow window still edits", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-file-guard");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  const onDisk = () => fs.readFileSync(widget, "utf8");

  // Open File… makes a tab of its own, beside the terminal's.
  await openFileFromPalette(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");
  const dirtyDot = header(window).locator('[data-testid="file-pane-dirty"]');
  await typeAtEnd(window, "// unsaved");
  await expect(dirtyDot).toBeVisible();

  // Convert to › Terminal on the dirty pane: the confirm, and Cancel keeps it all.
  const dialog = window.locator('[data-testid="unsaved-edits-dialog"]');
  await pane(window).locator('[data-testid="file-pane-breadcrumb"]').click({ button: "right" });
  await window.getByRole("menuitem", { name: "Convert to" }).hover();
  await window.getByRole("menuitem", { name: "Terminal" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Unsaved changes to Widget.tsx");
  await expect(dialog.locator('[data-testid="unsaved-edits-save"]')).toHaveText("Save and convert");
  await expect(dialog.locator('[data-testid="unsaved-edits-discard"]')).toHaveText(
    "Discard and convert",
  );
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "convert-confirm") });
  await dialog.locator('[data-testid="unsaved-edits-cancel"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(pane(window)).toBeVisible();
  await expect(editor).toContainText("// unsaved");
  await expect(dirtyDot).toBeVisible();

  // Close Other Tabs from the terminal's tab would close the file's: the
  // confirm again, and Cancel closes nothing.
  const tabs = window.locator('[data-testid="tab"]:visible');
  await expect(tabs).toHaveCount(2);
  await tabs.first().click({ button: "right" });
  await window.getByRole("menuitem", { name: "Close Other Tabs" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Unsaved changes to Widget.tsx");
  await expect(dialog.locator('[data-testid="unsaved-edits-discard"]')).toHaveText(
    "Discard and close",
  );
  await window.screenshot({ path: shot(testInfo, "close-other-tabs-confirm") });
  await dialog.locator('[data-testid="unsaved-edits-cancel"]').click();
  await expect(tabs).toHaveCount(2);
  expect(onDisk()).not.toContain("// unsaved");

  // A narrow desktop window is no phone: the file pane still edits and saves.
  await tabs.nth(1).click();
  await window.setViewportSize({ width: 700, height: 800 });
  await expect(pane(window)).toBeVisible();
  await expect(editor.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await typeAtEnd(window, "// narrow");
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(onDisk).toContain("// unsaved// narrow");
  await window.screenshot({ path: shot(testInfo, "narrow-window-editable") });
});

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
}

/** The line the editor's cursor is on, by its gutter. */
const activeLine = (window: Page) =>
  pane(window).locator(".cm-lineNumbers .cm-activeLineGutter");

test("the palette's Split with Source Control opens a file pane on its Source Control", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-split-scm");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET.replace("Clicked", "Pressed"));

  // The Diff pane's old words still find it, under its new name.
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("split diff");
  const item = window.locator("[cmdk-item]", { hasText: "Split with Source Control" });
  await expect(item).toBeVisible();
  await expect(window.locator("[cmdk-item]", { hasText: "Split with Diff" })).toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "palette-scm") });
  await item.first().click();

  // Beside the terminal, a file pane with nothing open, on Source Control.
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  await expect(
    drawer.locator('[data-testid="scm-row"][data-path="src/components/Widget.tsx"]'),
  ).toHaveAttribute("data-letter", "M", { timeout: 30_000 });
  // Nothing open yet: the editor points at the changes, not the tree.
  await expect(pane(window).locator('[data-testid="file-pane-empty"]')).toHaveText(
    "Pick a change to see its diff",
  );
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "split-scm") });
});

test("a file path printed in the terminal opens in a file pane at its line", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-from-terminal");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);

  const printed = "src/components/Widget.tsx:8";
  await runInTerminal(window, `echo ${printed}`);
  await expect.poll(() => paneText(window, termId)).toMatch(/^src\/components\/Widget\.tsx:8/m);

  // The first hover lists the workspace; until that answers there is no link.
  const openItem = window.locator('[data-testid="terminal-link-open-file-pane"]');
  await expect(async () => {
    await rightClickText(window, termId, printed);
    if (!(await openItem.isVisible())) {
      await window.keyboard.press("Escape");
      throw new Error("no file link yet");
    }
  }).toPass({ timeout: 15_000 });
  await expect(window.locator('[data-testid="terminal-link-open-file-tab"]')).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "terminal-file-link-menu") });

  await openItem.click();
  await expect(pane(window)).toBeVisible();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect(window.locator(`[data-pane-id="${termId}"] [data-testid="terminal-pane"]`)).toBeVisible();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText(
    "Widget.tsx",
  );
  await expect(activeLine(window)).toHaveText("8");
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "from-terminal") });
});

test("the file pane marks what changed: tree badges, gutter, edit jumps and the changes list", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-markers");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');

  // An agent changes two separate lines of Widget.tsx and adds a file.
  fs.writeFileSync(
    widget,
    WIDGET.replace("A counter, so", "A counter, edited so").replace("Clicked", "Pressed"),
  );
  fs.writeFileSync(path.join(ws, "src", "helper.ts"), "export const helper = 1;\n");
  // Its PostToolUse hook names the file it wrote, as Claude's does.
  await runInTerminal(
    window,
    `curl -sS -o /dev/null "http://127.0.0.1:$MANOR_HOOK_PORT/hook/event?paneId=$MANOR_PANE_ID&sessionId=e2e-edit&kind=claude&eventType=PostToolUse&filePath=$PWD/src/components/Widget.tsx" && touch "$HOME/hook-sent"`,
  );
  await expect.poll(() => fs.existsSync(path.join(tempHome, "hook-sent"))).toBe(true);

  await openFileFromPalette(window);
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toBeVisible();

  // The tree badges the changed files and dots their folders, which start open.
  const badge = (p: string) => treeRow(window, p).locator('[data-testid="file-pane-change-badge"]');
  await expect(badge("src/components/Widget.tsx")).toHaveText("M", { timeout: 30_000 });
  await expect(badge("src/helper.ts")).toHaveText("A");
  await expect(treeRow(window, "src").locator('[data-testid="file-pane-dir-dot"]')).toBeVisible();
  await expect(
    treeRow(window, "src/components").locator('[data-testid="file-pane-dir-dot"]'),
  ).toBeVisible();
  await expect(pane(window).locator('[data-testid="file-pane-scm-count"]')).toHaveText("2");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "markers-tree") });

  // The changed file: a bar on each changed line, a mark for each in the lane,
  // and the header's jump control.
  await treeRow(window, "src/components/Widget.tsx").click();
  await expect(drawer).toBeVisible();
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Pressed {count} times");
  await expect(editor.locator(".cm-line.cm-change-agent")).toHaveCount(2);
  const marks = pane(window).locator('[data-testid="file-pane-mark"][data-kind="agent"]');
  await expect(marks).toHaveCount(2);
  const jump = header(window).locator('[data-testid="file-pane-edit-jump"]');
  await expect(jump.locator('[data-testid="file-pane-edit-jump-label"]')).toHaveText("2 changes");
  await expect(jump.locator('[data-testid="file-pane-agent-chip"]')).toBeVisible();

  // ↓ goes to the first change, then the next; ⌥↑ in the editor goes back.
  await jump.locator('[data-testid="file-pane-edit-next"]').click();
  await expect(jump.locator('[data-testid="file-pane-edit-jump-label"]')).toHaveText("1 of 2 changes");
  await expect(activeLine(window)).toHaveText("3");
  await jump.locator('[data-testid="file-pane-edit-next"]').click();
  await expect(jump.locator('[data-testid="file-pane-edit-jump-label"]')).toHaveText("2 of 2 changes");
  await expect(activeLine(window)).toHaveText("8");
  await window.screenshot({ path: shot(testInfo, "markers-editor") });
  await window.keyboard.press("Alt+ArrowUp");
  await expect(activeLine(window)).toHaveText("3");
  // A lane mark goes to its line.
  await marks.nth(1).click();
  await expect(activeLine(window)).toHaveText("8");

  // Unsaved lines are yours (blue), and the header asks for a save instead.
  await typeAtEnd(window, "// mine");
  await expect(editor.locator(".cm-line.cm-change-mine")).toHaveCount(1);
  await expect(jump).toBeHidden();
  await expect(header(window).locator('[data-testid="file-pane-save-hint"]')).toBeVisible();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(".cm-line.cm-change-mine")).toHaveCount(0);

  // Source Control: both files under Changes (nothing staged yet), the
  // agent's with its chip, the new file untracked.
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  const changesGroup = drawer.locator('[data-testid="scm-group-changes"]');
  await expect(changesGroup.locator('[data-testid="scm-row"]')).toHaveCount(2);
  await expect(drawer.locator('[data-testid="scm-group-staged"]')).toHaveCount(0);
  const scmRow = (p: string) => changesGroup.locator(`[data-testid="scm-row"][data-path="${p}"]`);
  await expect(scmRow("src/components/Widget.tsx")).toHaveAttribute("data-letter", "M");
  await expect(
    scmRow("src/components/Widget.tsx").locator('[data-testid="file-pane-agent-chip"]'),
  ).toBeVisible();
  await expect(scmRow("src/helper.ts")).toHaveAttribute("data-letter", "U");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "changed-list") });

  // A new file is all green, with nothing to jump between (opened as the
  // plain file: a row's own click shows its diff).
  await scmRow("src/helper.ts").hover();
  await scmRow("src/helper.ts").locator('[data-testid="scm-open"]').click();
  await expect(editor).toContainText("export const helper = 1;");
  await expect(editor.locator(".cm-line.cm-change-added")).toHaveCount(1);
  await expect(header(window).locator('[data-testid="file-pane-edit-jump"]')).toBeHidden();
});

test("Source Control stages, unstages and discards a workspace's changes", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-scm");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET.replace("Clicked", "Pressed"));
  fs.writeFileSync(path.join(ws, "src", "helper.ts"), "export const helper = 1;\n");

  await openFileFromPalette(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  const staged = drawer.locator('[data-testid="scm-group-staged"]');
  const changes = drawer.locator('[data-testid="scm-group-changes"]');
  const row = (group: typeof drawer, p: string) =>
    group.locator(`[data-testid="scm-row"][data-path="${p}"]`);
  await expect(row(changes, "src/helper.ts")).toHaveAttribute("data-letter", "U", { timeout: 30_000 });
  await expect(row(changes, "src/components/Widget.tsx")).toHaveAttribute("data-letter", "M");

  // Stage: the new file moves to Staged and reads A.
  await row(changes, "src/helper.ts").hover();
  await row(changes, "src/helper.ts").locator('[data-testid="scm-stage"]').click();
  await expect(row(staged, "src/helper.ts")).toHaveAttribute("data-letter", "A");
  await expect.poll(() => execSync("git diff --cached --name-only", { cwd: ws }).toString().trim()).toBe(
    "src/helper.ts",
  );
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "scm-staged") });

  // Unstage: back under Changes, once the stage has answered.
  const unstage = row(staged, "src/helper.ts").locator('[data-testid="scm-unstage"]');
  await row(staged, "src/helper.ts").hover();
  await expect(unstage).not.toHaveAttribute("aria-disabled", "true");
  await unstage.click();
  await expect(row(changes, "src/helper.ts")).toHaveAttribute("data-letter", "U");
  await expect(staged).toHaveCount(0);

  // Discard asks first; Cancel keeps the change, Discard drops it.
  const widgetRow = row(changes, "src/components/Widget.tsx");
  await widgetRow.hover();
  await widgetRow.locator('[data-testid="scm-discard"]').click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toContainText("Discard changes?");
  await window.screenshot({ path: shot(testInfo, "scm-discard-confirm") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(widgetRow).toBeVisible();
  await widgetRow.hover();
  await widgetRow.locator('[data-testid="scm-discard"]').click();
  await window.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
  await expect(widgetRow).toHaveCount(0);
  expect(fs.readFileSync(path.join(ws, "src", "components", "Widget.tsx"), "utf8")).toBe(WIDGET);

  // Branch: what the workspace's branch changed since it left the project's
  // default branch (the fixture's `main`). Move `main` up to the baseline
  // (it is checked out in the project's own folder, so by ref, not by
  // checkout), then commit a change here that `main` doesn't have.
  git(ws, "update-ref refs/heads/main HEAD");
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET.replace("Clicked", "Tapped"));
  git(ws, "commit -qam \"Tap, not click\"");
  await drawer.locator('[data-testid="scm-mode"] [data-value="branch"]').click();
  await expect(drawer.locator('[data-testid="scm"]')).toHaveAttribute("data-view", "branch");
  const branchGroup = drawer.locator('[data-testid="scm-group-branch"]');
  const branchRow = row(branchGroup, "src/components/Widget.tsx");
  await expect(branchRow).toHaveAttribute("data-letter", "M", { timeout: 30_000 });
  await window.screenshot({ path: shot(testInfo, "scm-branch") });

  // Its row shows the file's diff against `main`: the committed change, old line above new.
  await branchRow.locator("button").first().click();
  await expect(pane(window).locator('[data-testid="file-pane-diff-tag"]')).toHaveText("Diff vs main");
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor.locator(".cm-deletedChunk")).toContainText("Clicked {count} times");
  await expect(editor.locator(".cm-changedLine")).toContainText("Tapped {count} times");
  await window.screenshot({ path: shot(testInfo, "scm-branch-diff") });
});

test("a Source Control row shows its file's diff in the editor, which edits and saves", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-scm-diff");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.writeFileSync(path.join(ws, "src", "doomed.ts"), "export const doomed = 1;\n");
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
  fs.rmSync(path.join(ws, "src", "doomed.ts"));

  await openFileFromPalette(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  const row = (p: string) => drawer.locator(`[data-testid="scm-row"][data-path="${p}"]`);
  await expect(row("src/components/Widget.tsx")).toHaveAttribute("data-letter", "M", { timeout: 30_000 });

  // The row's click: the file's diff vs HEAD, the old line struck above the new.
  await row("src/components/Widget.tsx").locator("button").first().click();
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  const tag = pane(window).locator('[data-testid="file-pane-diff-tag"]');
  await expect(tag).toHaveText("Diff vs HEAD");
  await expect(editor.locator(".cm-deletedChunk")).toContainText("Clicked {count} times");
  await expect(editor.locator(".cm-changedLine")).toContainText("Pressed {count} times");
  await expect(editor.locator(".cm-collapsedLines").first()).toContainText("unchanged lines");
  await expect(pane(window).locator('[data-testid="file-pane-diff-stale"]')).toHaveCount(0);
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "diff-dark") });

  // The working side edits and saves like the plain editor.
  await editor.locator(".cm-changedLine").first().click();
  await window.keyboard.press("End");
  await window.keyboard.type(" // from the diff");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toBeVisible();
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => fs.readFileSync(widget, "utf8")).toContain("Pressed {count} times // from the diff");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
  // Saved, the diff still stands against HEAD.
  await expect(editor.locator(".cm-deletedChunk")).toContainText("Clicked {count} times");
  await expect(editor.locator(".cm-changedLine")).toContainText("// from the diff");
  await expect(pane(window).locator('[data-testid="file-pane-diff-stale"]')).toHaveCount(0);

  // Unsaved edits ask before another row's diff, deleted or not, and Cancel
  // leaves this file's diff as it was.
  const swapBar = pane(window).locator('[data-testid="file-pane-swap-bar"]');
  await editor.locator(".cm-changedLine").first().click();
  await window.keyboard.press("End");
  await window.keyboard.type("!");
  await drawer.locator('[data-testid="scm-row"][data-path="src/doomed.ts"] button').first().click();
  await expect(swapBar).toBeVisible();
  await expect(pane(window).locator('[data-testid="file-pane-deleted-diff"]')).toHaveCount(0);
  await pane(window).locator('[data-testid="file-pane-swap-cancel"]').click();
  await expect(swapBar).toHaveCount(0);
  await expect(tag).toHaveText("Diff vs HEAD");
  await expect(editor.locator(".cm-deletedChunk")).toContainText("Clicked {count} times");
  await editor.locator(".cm-changedLine").first().click();
  await window.keyboard.press("End");
  await window.keyboard.press("Backspace");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);

  // Open file: the plain editor, same file, with its change marks back.
  await pane(window).locator('[data-testid="file-pane-open-plain"]').click();
  await expect(tag).toHaveCount(0);
  await expect(editor.locator(".cm-deletedChunk")).toHaveCount(0);
  await expect(editor).toContainText("Pressed {count} times // from the diff");
  await expect(editor.locator(".cm-line.cm-change-agent").first()).toBeVisible({ timeout: 10_000 });

  // A deleted file: its old content, all removed, read-only.
  await drawer.locator('[data-testid="scm-row"][data-path="src/doomed.ts"] button').first().click();
  const deleted = pane(window).locator('[data-testid="file-pane-deleted-diff"]');
  await expect(deleted.locator(".cm-deletedChunk")).toContainText("export const doomed = 1;");
  await expect(tag).toHaveText("Diff vs HEAD");
  await window.screenshot({ path: shot(testInfo, "diff-deleted") });

  // Close diff goes back to the file it was opened over.
  await pane(window).locator('[data-testid="file-pane-close-diff"]').click();
  await expect(deleted).toHaveCount(0);
  await expect(editor).toContainText("Pressed {count} times // from the diff");
  await drawer.locator('[data-testid="scm-row"][data-path="src/doomed.ts"] button').first().click();
  await expect(deleted.locator(".cm-deletedChunk")).toContainText("export const doomed = 1;");

  // Picking from the tree shows the plain file again.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  await expect(deleted).toHaveCount(0);
  await expect(tag).toHaveCount(0);
  await expect(editor).toContainText("Pressed {count} times // from the diff");

  // Light theme.
  await useLightTheme(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await row("src/components/Widget.tsx").locator("button").first().click();
  await expect(editor.locator(".cm-deletedChunk")).toBeVisible();
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "diff-light") });
});

test("selected lines in a file's diff take a review comment, shown as a card under them", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-diff-comments");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  const other = path.join(ws, "src", "other.ts");
  fs.writeFileSync(other, "export const other = 1;\n");
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
  fs.writeFileSync(other, "export const other = 2;\n");

  await openFileFromPalette(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  const row = (p: string) => drawer.locator(`[data-testid="scm-row"][data-path="${p}"]`);
  await expect(row("src/components/Widget.tsx")).toHaveAttribute("data-letter", "M", { timeout: 30_000 });
  await row("src/components/Widget.tsx").locator("button").first().click();
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor.locator(".cm-changedLine")).toContainText("Pressed {count} times");

  // Select the <button> line and the changed one under it: the chip offers a comment.
  await editor.locator(".cm-changedLine").first().click();
  await window.keyboard.press("End");
  await window.keyboard.press("Shift+ArrowUp");
  const chip = window.locator('[data-testid="diff-comment-chip"]');
  await expect(chip).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "comment-chip") });

  // The composer opens under the lines; Save adds the card there.
  await chip.click();
  const composer = editor.locator('[data-testid="diff-comment-composer"]');
  await expect(composer).toContainText("L7–L8");
  await composer.locator("textarea").fill("Why the rename?");
  await window.screenshot({ path: shot(testInfo, "comment-composer") });
  await composer.locator('[data-testid="diff-comment-save"]').click();
  const card = editor.locator('[data-testid="diff-comment-card"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("You · L7–L8");
  await expect(card).toContainText("Why the rename?");
  await expect(composer).toHaveCount(0);
  await expect(editor.locator(".cm-gutterElement.cm-commentedLine")).not.toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "comment-card") });

  // Edit it in place.
  await card.hover();
  await card.locator('[data-testid="diff-comment-edit"]').click();
  await expect(composer.locator("textarea")).toHaveValue("Why the rename?");
  await composer.locator("textarea").fill("Why the rename? Keep Clicked.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(card).toContainText("Keep Clicked.");

  // Another file's diff and back: the card is still under its lines.
  await row("src/other.ts").locator("button").first().click();
  await expect(editor.locator(".cm-changedLine")).toContainText("other = 2");
  await expect(card).toHaveCount(0);
  await row("src/components/Widget.tsx").locator("button").first().click();
  await expect(card).toContainText("You · L7–L8");
  await expect(card).toContainText("Keep Clicked.");

  // A line typed above moves it down with its lines.
  await editor.locator(".cm-line").first().click();
  await window.keyboard.press("Home");
  await window.keyboard.type("// top\n");
  await expect(card).toContainText("You · L8–L9");

  // Delete it.
  await card.hover();
  await card.locator('[data-testid="diff-comment-delete"]').click();
  await expect(card).toHaveCount(0);
  await expect(editor.locator(".cm-gutterElement.cm-commentedLine")).toHaveCount(0);
});

test("Source Control lists the review's comments, each opening its card, and the diff floats Send", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-review-section");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), WIDGET.replace("Clicked", "Pressed"));

  await openFileFromPalette(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  const row = drawer.locator('[data-testid="scm-row"][data-path="src/components/Widget.tsx"]');
  await expect(row).toHaveAttribute("data-letter", "M", { timeout: 30_000 });
  await row.locator("button").first().click();
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor.locator(".cm-changedLine")).toContainText("Pressed {count} times");

  // No drafts: no section, no floating bar.
  const section = drawer.locator('[data-testid="scm-review-section"]');
  const floatBar = pane(window).locator('[data-testid="review-float-bar"]');
  await expect(section).toHaveCount(0);
  await expect(floatBar).toHaveCount(0);

  // Comment on the changed line and the one above it.
  await editor.locator(".cm-changedLine").first().click();
  await window.keyboard.press("End");
  await window.keyboard.press("Shift+ArrowUp");
  await window.locator('[data-testid="diff-comment-chip"]').click();
  const composer = editor.locator('[data-testid="diff-comment-composer"]');
  await composer.locator("textarea").fill("Why the rename?");
  await composer.locator('[data-testid="diff-comment-save"]').click();
  const card = editor.locator('[data-testid="diff-comment-card"]');
  await expect(card).toHaveCount(1);

  // The section lists it, pinned under the changes; the diff floats the bar.
  const item = section.locator('[data-testid="scm-review-item"]');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Widget.tsx:7–8");
  await expect(item).toContainText("Why the rename?");
  await expect(section.locator('[data-testid="scm-review-send"]')).toContainText("Send to");
  await expect(floatBar).toBeVisible();
  await expect(floatBar).toContainText("1 comment");
  await expect(floatBar.locator('[data-testid="review-float-send"]')).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "review-float") });

  // The bar's count lists the comments too.
  await floatBar.getByLabel("Jump to a comment").click();
  const list = window.locator('[data-testid="review-float-list"]');
  await expect(list).toContainText("Why the rename?");
  await window.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // From the plain file: the item opens the diff and shows its card.
  await pane(window).locator('[data-testid="file-pane-open-plain"]').click();
  await expect(card).toHaveCount(0);
  await expect(floatBar).toHaveCount(0);
  await expect(section).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "review-section") });
  await item.click();
  await expect(pane(window).locator('[data-testid="file-pane-diff-tag"]')).toContainText("Diff vs HEAD");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Why the rename?");
  await expect(floatBar).toBeVisible();

  await useLightTheme(window);
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "review-section-light") });

  // Discard asks once more, then the drafts, the section and the bar go.
  const discard = section.locator('[data-testid="scm-review-discard"]');
  await discard.click();
  await expect(discard).toContainText("Discard 1 comment?");
  await discard.click();
  await expect(section).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await expect(floatBar).toHaveCount(0);
});

test("Source Control commits what's staged with the message typed above it", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-scm-commit");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  // The app's own `git commit` needs an identity; the temp home has none.
  git(ws, "config user.name e2e");
  git(ws, "config user.email e2e@example.com");
  fs.writeFileSync(path.join(ws, "src", "helper.ts"), "export const helper = 1;\n");

  await openFileFromPalette(window);
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  const changes = drawer.locator('[data-testid="scm-group-changes"]');
  const staged = drawer.locator('[data-testid="scm-group-staged"]');
  const commit = drawer.locator('[data-testid="scm-commit"]');
  const message = drawer.locator('[data-testid="scm-commit-message"]');
  await expect(changes.locator('[data-testid="scm-row"][data-path="src/helper.ts"]')).toBeVisible({
    timeout: 30_000,
  });

  // Nothing staged yet: Commit waits, however much is typed.
  await message.fill("Add the helper");
  await expect(commit).toHaveAttribute("aria-disabled", "true");

  await changes.locator("button[aria-expanded]").first().hover();
  await changes.locator('[data-testid="scm-stage-all"]').click();
  await expect(staged.locator('[data-testid="scm-row"]')).toHaveCount(1);
  await expect(commit).not.toHaveAttribute("aria-disabled", "true");
  await window.screenshot({ path: shot(testInfo, "scm-commit-ready") });

  // ⌘/Ctrl+Enter commits; the list empties and the message clears.
  await message.press("ControlOrMeta+Enter");
  await expect(drawer.locator('[data-testid="scm-empty"]')).toBeVisible({ timeout: 30_000 });
  await expect(message).toHaveValue("");
  expect(execSync("git log -1 --format=%s", { cwd: ws }).toString().trim()).toBe("Add the helper");

  // Push and Commit & Push wait in Commit's menu; with nothing staged only Push is live.
  await drawer.locator('[data-testid="scm-commit-menu"]').click();
  await expect(window.locator('[data-testid="scm-push"]')).toBeEnabled();
  await expect(window.locator('[data-testid="scm-commit-push"]')).toBeDisabled();
  await window.screenshot({ path: shot(testInfo, "scm-commit-menu") });
});

/** Seed `src/components/Widget.tsx` through the workspace's own shell; returns the workspace. */
async function seedWidget(window: Page, tempHome: string): Promise<string> {
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  return ws;
}

test("Cmd/Ctrl-clicking a file path in the terminal opens it in a file pane", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-cmd-click");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await seedWidget(window, tempHome);

  const printed = "src/components/Widget.tsx:5";
  await runInTerminal(window, `echo ${printed}`);
  await expect.poll(() => paneText(window, termId)).toMatch(/^src\/components\/Widget\.tsx:5/m);

  // The first hover lists the workspace; until that answers the click is a
  // plain one, so click again until a file pane opens.
  await expect(async () => {
    if ((await pane(window).count()) === 0) await modifierClickText(window, termId, printed);
    await expect(pane(window)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

  // Straight into the file pane, not the link menu.
  await expect(window.locator('[role="menu"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText(
    "Widget.tsx",
  );
  await expect(activeLine(window)).toHaveText("5");
});

test("the file pane works in the left half of a split, and its drawer beside a rail sidebar", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-file-left");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  const widget = path.join(ws, "src", "components", "Widget.tsx");

  await openFileFromPalette(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");

  // Split with › Terminal from the file pane's menu: the new pane takes the
  // right half, leaving the file pane on the left.
  await pane(window).locator('[data-testid="file-pane-breadcrumb"]').click({ button: "right" });
  await window.getByRole("menuitem", { name: "Split with" }).hover();
  await window.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  const panes = window.locator('[data-testid="workspace-pane"]:visible');
  await expect(panes).toHaveCount(2);
  const other = panes.filter({ hasNot: pane(window) });
  await expect(other.locator('[data-testid="terminal-pane"]')).toBeVisible();
  const fileBox = (await pane(window).boundingBox())!;
  const otherBox = (await other.boundingBox())!;
  expect(fileBox.x + fileBox.width).toBeLessThanOrEqual(otherBox.x + 1);

  // It still edits and saves from there.
  await typeAtEnd(window, "// left");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toBeVisible();
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => fs.readFileSync(widget, "utf8")).toContain("// left");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "left-half") });

  // The sidebar collapsed to its rail, and the Files drawer open: the drawer
  // stays inside the pane, clear of the rail.
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Collapse Sidebar");
  await window.locator("[cmdk-item]", { hasText: "Collapse Sidebar" }).first().click();
  const rail = window.locator('[data-testid="sidebar-rail"]');
  await expect(rail).toBeVisible();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  if (!(await drawer.isVisible())) {
    await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  }
  await expect(drawer).toBeVisible();
  await expect(treeRow(window, "src/components/Widget.tsx")).toBeVisible();
  await expect
    .poll(async () => {
      const railBox = (await rail.boundingBox())!;
      const drawerBox = (await drawer.boundingBox())!;
      const paneBox = (await pane(window).boundingBox())!;
      return (
        drawerBox.x >= railBox.x + railBox.width &&
        drawerBox.x >= paneBox.x &&
        drawerBox.x + drawerBox.width <= paneBox.x + paneBox.width + 1
      );
    })
    .toBe(true);
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "sidebar-rail-drawer") });
});

test("the Files drawer sits beside the editor, resizes from its edge and collapses into the strip", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-file-drawer");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  // Rows enough above Widget.tsx that reopening the tree aims past the
  // overscan, few enough that the tree still fits without scrolling.
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(ws, "src", "components", `aa-${String(i).padStart(2, "0")}.ts`), `export const a${i} = ${i};\n`);
  }

  await openFileFromPalette(window);
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toBeVisible();
  // Opened from the keyboard, its tree takes focus without the clipped
  // global ring: the row it is on is outlined inside instead.
  const tree = pane(window).locator('[data-testid="file-pane-tree"]');
  await expect(tree).toBeFocused();
  expect(await tree.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");

  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");

  // The editor gives way to the drawer instead of sliding under it.
  const editorCol = pane(window).locator('[data-testid="file-pane-breadcrumb"]');
  const besideDrawer = async () => {
    const drawerBox = (await drawer.boundingBox())!;
    const editorBox = (await editorCol.boundingBox())!;
    return editorBox.x >= drawerBox.x + drawerBox.width - 1;
  };
  await expect.poll(besideDrawer).toBe(true);

  // Shut and opened again on a short tree: its rows start at the top.
  const filesButton = pane(window).locator('[data-testid="file-pane-files-button"]');
  await filesButton.click();
  await expect(drawer).toBeHidden();
  await filesButton.click();
  await expect(drawer).toBeVisible();
  await expect(treeRow(window, "src/components/Widget.tsx")).toBeVisible();
  // The topmost row drawn sits under the header, not part-way down.
  await expect
    .poll(() =>
      drawer.evaluate((el) => {
        const rows = [...el.querySelectorAll('[data-testid="file-pane-tree-row"]')];
        const top = Math.min(...rows.map((r) => r.getBoundingClientRect().top));
        return top - el.getBoundingClientRect().top;
      }),
    )
    .toBeLessThan(40);
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "drawer-docked") });

  // Dragging its edge widens it, and the editor moves over.
  const handle = pane(window).locator('[data-testid="file-pane-drawer-resize"]');
  const startWidth = (await drawer.boundingBox())!.width;
  const drag = async (dx: number) => {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x + dx / 2, y, { steps: 4 });
    await window.mouse.move(x + dx, y, { steps: 4 });
    await window.mouse.up();
  };
  await drag(100);
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBeGreaterThan(startWidth + 90);
  await expect.poll(besideDrawer).toBe(true);
  const widened = (await drawer.boundingBox())!.width;
  await window.screenshot({ path: shot(testInfo, "drawer-widened") });

  // Dragged back into the strip, it collapses; dragged out, it opens at the
  // width it had.
  await drag(-widened);
  await expect(drawer).toBeHidden();
  await expect(filesButton).toHaveAttribute("aria-pressed", "false");
  await drag(widened);
  await expect(drawer).toBeVisible();
  await expect.poll(async () => Math.abs((await drawer.boundingBox())!.width - widened)).toBeLessThan(4);
  await expect(drawer).toHaveAttribute("data-mode", "files");
});

test("the Files tree's context menu copies paths, renames and deletes files", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-tree-menu");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "widget.ts"), WIDGET);
  fs.writeFileSync(path.join(ws, "notes.md"), "# notes\n");

  await openFileFromPalette(window);
  await openFromTree(window, ["src", "widget.ts"]);
  const menu = window.locator('[data-testid="file-pane-tree-menu"]');

  // A file's menu: the editor and Finder (a local workspace), its paths, and Rename and Delete.
  await treeRow(window, "src/widget.ts").click({ button: "right" });
  await expect(menu).toBeVisible();
  for (const item of ["Open in Editor", /Reveal in Finder|Show in Folder/, "Copy Path", "Copy Relative Path", "Rename…", "Delete…"]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "tree-menu-file") });
  await menu.locator('[data-testid="file-pane-tree-copy-relative-path"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("src/widget.ts");

  await treeRow(window, "src/widget.ts").click({ button: "right" });
  await menu.locator('[data-testid="file-pane-tree-copy-path"]').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${ws}/src/widget.ts`);

  // A folder's: no Rename or Delete.
  await treeRow(window, "src").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Copy Path" })).toBeVisible();
  await expect(menu.locator('[data-testid="file-pane-tree-rename"]')).toHaveCount(0);
  await expect(menu.locator('[data-testid="file-pane-tree-delete"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Rename the open file in its row: it moves on disk and the pane follows it.
  await treeRow(window, "src/widget.ts").click({ button: "right" });
  await menu.locator('[data-testid="file-pane-tree-rename"]').click();
  const input = pane(window).locator('[data-testid="file-pane-rename-input"]');
  await expect(input).toBeFocused();
  // The name without its extension is selected: typing replaces only that.
  await window.keyboard.type("gadget");
  await expect(input).toHaveValue("gadget.ts");
  await window.screenshot({ path: shot(testInfo, "tree-rename") });
  await window.keyboard.press("Enter");
  await expect(treeRow(window, "src/gadget.ts")).toBeVisible();
  await expect(treeRow(window, "src/widget.ts")).toHaveCount(0);
  expect(fs.existsSync(path.join(ws, "src", "widget.ts"))).toBe(false);
  expect(fs.readFileSync(path.join(ws, "src", "gadget.ts"), "utf8")).toBe(WIDGET);
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("gadget.ts");
  await expect(pane(window).locator('[data-testid="file-pane-editor"]')).toContainText("Clicked {count} times");

  // Renaming onto a file that exists is refused, and Escape leaves the name as it was.
  await treeRow(window, "notes.md").click({ button: "right" });
  await menu.locator('[data-testid="file-pane-tree-rename"]').click();
  await input.fill("src/gadget.ts");
  await window.keyboard.press("Enter");
  await expect(window.getByText("src/gadget.ts already exists")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(pane(window).locator('[data-testid="file-pane-drawer"]')).toBeVisible();
  expect(fs.readFileSync(path.join(ws, "notes.md"), "utf8")).toBe("# notes\n");

  // Delete asks first, then removes the file from disk and the tree.
  await treeRow(window, "notes.md").click({ button: "right" });
  await menu.locator('[data-testid="file-pane-tree-delete"]').click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toContainText("Delete notes.md?");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "tree-delete-confirm") });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(treeRow(window, "notes.md")).toHaveCount(0);
  expect(fs.existsSync(path.join(ws, "notes.md"))).toBe(false);
});

test("the file pane's drawer survives a move, and the keyboard drives it and its tree", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-file-keys");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  const ws = await seedWidget(window, tempHome);
  fs.writeFileSync(path.join(ws, "src", "components", "Zed.tsx"), "export const zed = 1;\n");

  await openFileFromPalette(window);
  await openFromTree(window, ["src", "components", "Widget.tsx"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Clicked {count} times");
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  const tree = pane(window).locator('[data-testid="file-pane-tree"]');
  const cursorRow = tree.locator('[data-testid="file-pane-tree-row"][class*="rowCursor"]');

  // The clicked row is the keyboard's, outlined inside the row.
  await expect(tree).toBeFocused();
  await expect(cursorRow).toHaveAttribute("data-path", "src/components/Widget.tsx");
  expect(
    await cursorRow.locator("button").evaluate((el) => getComputedStyle(el).boxShadow),
  ).not.toBe("none");
  await window.screenshot({ path: shot(testInfo, "tree-cursor") });

  // ↓ moves to the next file, Enter opens it, Space opens the one above.
  await window.keyboard.press("ArrowDown");
  await expect(cursorRow).toHaveAttribute("data-path", "src/components/Zed.tsx");
  await window.keyboard.press("Enter");
  await expect(editor).toContainText("export const zed");
  await expect(tree).toBeFocused();
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press(" ");
  await expect(editor).toContainText("Clicked {count} times");

  // ← steps out to the folder, then closes it; → opens it again.
  await window.keyboard.press("ArrowLeft");
  await expect(cursorRow).toHaveAttribute("data-kind", "dir");
  await window.keyboard.press("ArrowLeft");
  await expect(treeRow(window, "src/components/Widget.tsx")).toHaveCount(0);
  await window.keyboard.press("ArrowRight");
  await expect(treeRow(window, "src/components/Widget.tsx")).toBeVisible();

  // ⌘B / Ctrl+B hides the drawer and hands the keyboard to the editor; again, shows it.
  await window.keyboard.press("ControlOrMeta+b");
  await expect(drawer).toBeHidden();
  await expect(editor.locator(".cm-content")).toBeFocused();
  await window.keyboard.press("ControlOrMeta+b");
  await expect(drawer).toHaveAttribute("data-mode", "files");
  await expect(tree).toBeFocused();

  // ⌘⇧G goes to Source Control, ⌘⇧E back to Files, and ⌘⇧E again to the editor.
  await window.keyboard.press("ControlOrMeta+Shift+g");
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  await window.keyboard.press("ControlOrMeta+Shift+e");
  await expect(drawer).toHaveAttribute("data-mode", "files");
  await expect(tree).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Shift+e");
  await expect(editor.locator(".cm-content")).toBeFocused();
  await expect(drawer).toBeVisible();
  // Escape from the tree closes the drawer onto the editor.
  await window.keyboard.press("ControlOrMeta+Shift+e");
  await expect(tree).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(editor.locator(".cm-content")).toBeFocused();

  // On Source Control, then moved (a split rebuilds the pane): it comes
  // back on Source Control.
  await window.keyboard.press("ControlOrMeta+Shift+g");
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  const split = async () => {
    await pane(window).locator('[data-testid="file-pane-breadcrumb"]').click({ button: "right" });
    await window.getByRole("menuitem", { name: "Split with" }).hover();
    await window.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  };
  await split();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  // Closed, then moved again: it stays closed, and ⌘B opens the view it had.
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await expect(drawer).toBeHidden();
  await split();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(3);
  await window.waitForTimeout(300);
  await expect(drawer).toBeHidden();
  await editor.locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+b");
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  await window.screenshot({ path: shot(testInfo, "after-move") });
});
