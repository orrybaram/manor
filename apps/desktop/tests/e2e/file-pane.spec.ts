import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  importSeededProject,
  test,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  paneText,
  rightClickText,
  runInTerminal,
} from "./helpers/terminal";

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

  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  await expect(pane(window)).toBeVisible();
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
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  await expect(pane(window)).toBeVisible();
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

async function waitForWorktree(tempHome: string): Promise<string> {
  const root = path.join(tempHome, ".manor", "worktrees");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(root)) {
      for (const project of fs.readdirSync(root)) {
        for (const ws of fs.readdirSync(path.join(root, project))) {
          const dir = path.join(root, project, ws);
          if (fs.existsSync(path.join(dir, ".git"))) return dir;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no worktree under ${root}`);
}

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

test("Open File in the diff pane opens the changed file in a file pane beside it", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "ws-from-diff");
  const ws = await waitForWorktree(tempHome);
  const widget = path.join(ws, "src", "components", "Widget.tsx");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  fs.writeFileSync(path.join(ws, "src", "other.ts"), OTHER);
  fs.writeFileSync(path.join(ws, "src", "doomed.ts"), "export const doomed = 1;\n");
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
  fs.writeFileSync(path.join(ws, "src", "other.ts"), "export const other = 2;\n");
  fs.rmSync(path.join(ws, "src", "doomed.ts"));

  await window.keyboard.press("ControlOrMeta+Shift+g");
  const widgetFile = window.locator('[data-file-path="src/components/Widget.tsx"]');
  await expect(widgetFile).toBeVisible({ timeout: 60_000 });

  // A deleted file has nothing to open.
  await expect(
    window.locator('[data-file-path="src/doomed.ts"] [data-testid="diff-file-open"]'),
  ).toHaveCount(0);

  // Open File on the header: a file pane splits off to the right, on that file.
  await widgetFile.locator('[data-testid="diff-file-open"]').click();
  await expect(pane(window)).toBeVisible();
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText(
    "Widget.tsx",
  );
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("Pressed {count} times");
  const diffBox = (await window.locator('[data-file-path="src/other.ts"]').boundingBox())!;
  const fileBox = (await pane(window).boundingBox())!;
  expect(fileBox.x).toBeGreaterThan(diffBox.x);
  await window.waitForTimeout(500);
  await window.screenshot({ path: shot(testInfo, "from-diff") });

  // With unsaved edits, opening another file from the diff asks first, in the
  // same pane, instead of splitting again or dropping them.
  await typeAtEnd(window, "// unsaved");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toBeVisible();
  await window.locator('[data-file-path="src/other.ts"]').click({ button: "right" });
  await window.locator('[data-testid="diff-file-menu-open"]').click();
  const swap = pane(window).locator('[data-testid="file-pane-swap-bar"]');
  await expect(swap).toBeVisible();
  await expect(swap).toContainText("Unsaved changes to Widget.tsx.");
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
  await window.screenshot({ path: shot(testInfo, "from-diff-swap-confirm") });
  await swap.locator('[data-testid="file-pane-swap-discard"]').click();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText(
    "other.ts",
  );
  await expect(editor).toContainText("export const other = 2;");

  // A reused pane with its Files drawer open shows the file, not the tree.
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer).toBeVisible();
  await widgetFile.locator('[data-testid="diff-file-open"]').click();
  await expect(drawer).toBeHidden();
  await expect(editor).toContainText("Pressed {count} times");
  // The same file again only moves the cursor, and still closes the drawer.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer).toBeVisible();
  await widgetFile.locator('[data-testid="diff-file-open"]').click();
  await expect(drawer).toBeHidden();
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

  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
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
  await expect(pane(window).locator('[data-testid="file-pane-changes-count"]')).toHaveText("2");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "markers-tree") });

  // The changed file: a bar on each changed line, a mark for each in the lane,
  // and the header's jump control.
  await treeRow(window, "src/components/Widget.tsx").click();
  await expect(drawer).toBeHidden();
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

  // Changed by agents: the agent's file under its chip, the rest under Other changes.
  await pane(window).locator('[data-testid="file-pane-changes-button"]').click();
  await expect(drawer).toHaveAttribute("data-mode", "changes");
  const groups = drawer.locator('[data-testid="file-pane-changes-group"]');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator('[data-testid="file-pane-agent-chip"]')).toBeVisible();
  await expect(
    groups.nth(0).locator('[data-testid="file-pane-change-row"][data-path="src/components/Widget.tsx"]'),
  ).toBeVisible();
  await expect(groups.nth(1)).toContainText("Other changes");
  await expect(
    groups.nth(1).locator('[data-testid="file-pane-change-row"][data-path="src/helper.ts"]'),
  ).toContainText("A");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "changed-list") });

  // A new file is all green, with nothing to jump between.
  await groups.nth(1).locator('[data-testid="file-pane-change-row"][data-path="src/helper.ts"]').click();
  await expect(editor).toContainText("export const helper = 1;");
  await expect(editor.locator(".cm-line.cm-change-added")).toHaveCount(1);
  await expect(header(window).locator('[data-testid="file-pane-edit-jump"]')).toBeHidden();
});
