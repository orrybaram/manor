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
  // Two long files, one before Widget.tsx and one after it, so the list's
  // jump to Widget.tsx has somewhere to scroll and room to land at the top.
  const lines = (name: string, n: number) =>
    Array.from({ length: 60 }, (_, i) => `export const ${name}${i} = ${i + n};`).join("\n") + "\n";
  fs.writeFileSync(path.join(ws, "src", "components", "Big.tsx"), lines("big", 0));
  fs.writeFileSync(path.join(ws, "src", "long.ts"), lines("long", 0));
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');
  fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
  fs.writeFileSync(path.join(ws, "src", "other.ts"), "export const other = 2;\n");
  fs.rmSync(path.join(ws, "src", "doomed.ts"));
  fs.writeFileSync(path.join(ws, "src", "components", "Big.tsx"), lines("big", 1));
  fs.writeFileSync(path.join(ws, "src", "long.ts"), lines("long", 1));

  await window.keyboard.press("ControlOrMeta+Shift+g");
  const widgetFile = window.locator('[data-file-path="src/components/Widget.tsx"]');
  await expect(widgetFile).toBeVisible({ timeout: 60_000 });

  // The diff's file list, which shares its tree with the file pane: a row per
  // folder and per file.
  const list = window.locator('[data-testid="diff-file-list"]');
  const listDir = (p: string) => list.locator(`[data-testid="diff-file-list-dir"][data-path="${p}"]`);
  const listRow = (p: string) => list.locator(`[data-testid="diff-file-list-row"][data-path="${p}"]`);
  await expect(listDir("src")).toBeVisible();
  await expect(listDir("src/components")).toBeVisible();
  for (const p of [
    "src/components/Big.tsx",
    "src/components/Widget.tsx",
    "src/doomed.ts",
    "src/long.ts",
    "src/other.ts",
  ]) {
    await expect(listRow(p)).toBeVisible();
  }
  const diffPane = window.locator('[data-testid="workspace-pane"]:visible', { has: list });
  await window.waitForTimeout(500);
  await diffPane.screenshot({ path: shot(testInfo, "diff-file-list") });

  // A folder collapses and expands.
  await listDir("src/components").locator("button").first().click();
  await expect(listDir("src/components")).toHaveAttribute("data-collapsed", "true");
  await expect(listRow("src/components/Widget.tsx")).toHaveCount(0);
  await expect(listRow("src/other.ts")).toBeVisible();
  await listDir("src/components").locator("button").first().click();
  await expect(listDir("src/components")).toHaveAttribute("data-collapsed", "false");
  await expect(listRow("src/components/Widget.tsx")).toBeVisible();

  // A file's name in the list scrolls the diff to that file, under the header.
  const widgetGap = () =>
    window.evaluate(() => {
      const file = document.querySelector('[data-file-path="src/components/Widget.tsx"]')!;
      let scroller = file.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error("no scrolling ancestor");
      return file.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  expect(await widgetGap()).toBeGreaterThan(500);
  await listRow("src/components/Widget.tsx").locator('[title="src/components/Widget.tsx"]').click();
  await expect
    .poll(async () => {
      const gap = await widgetGap();
      return gap >= -2 && gap < 250;
    }, { timeout: 10_000 })
    .toBe(true);

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

  // A reused pane with its Files drawer open shows the file beside the tree.
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer).toBeVisible();
  await widgetFile.locator('[data-testid="diff-file-open"]').click();
  await expect(editor).toContainText("Pressed {count} times");
  await expect(drawer).toBeVisible();
  // The same file again only moves the cursor, and the tree stays.
  await widgetFile.locator('[data-testid="diff-file-open"]').click();
  await expect(drawer).toBeVisible();

  // The file list's own menu opens a file in the file pane too.
  await listRow("src/other.ts").click({ button: "right" });
  await window.locator('[data-testid="diff-file-list-open"]').click();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText(
    "other.ts",
  );
  await expect(editor).toContainText("export const other = 2;");
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(2);
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
  await expect(pane(window).locator('[data-testid="file-pane-changes-count"]')).toHaveText("2");
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
  // Opened from the keyboard, it takes focus without a ring.
  await expect(drawer).toBeFocused();
  expect(await drawer.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");

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
