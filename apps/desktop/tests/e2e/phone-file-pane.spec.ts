import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";

import { bootWorkspaceWithTerminal, expect } from "./fixtures";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The file pane on a paired phone (#458): the desk opens a file, the phone
 * switches to that pane and shows it read-only (no keyboard on a tap), follows
 * the file when it changes on disk, and opens another from the Files drawer.
 * Its Source Control (#489) floats over the editor, shows a change's diff,
 * keeps git's buttons off, and still takes a review comment.
 *
 * Like `phone.spec.ts`, the phone is a Playwright page at 390×844 that knows
 * only the pairing link, through a local relay (`helpers/relay-fixture.ts`):
 * build with `pnpm build && pnpm build:web:relay` first.
 */

const WIDGET = `export function widget(): string {\n  return "Clicked";\n}\n`;
const OTHER = `export const other = "the other file";\n`;

function shot(testInfo: TestInfo, name: string): string {
  return testInfo.outputPath(`${name}.png`);
}


const pane = (page: Page) => page.locator('[data-testid="file-pane"]:visible');

relayTest("a phone shows a file pane read-only, follows the file on disk, and opens another from the drawer", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  relayTest.setTimeout(240_000);

  // ── Desk: a workspace with two files, one open in a file pane ─────────
  await bootWorkspaceWithTerminal(app, window, tempHome, "phone-files");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const widget = path.join(ws, "src", "widget.ts");
  fs.mkdirSync(path.dirname(widget), { recursive: true });
  fs.writeFileSync(widget, WIDGET);
  fs.writeFileSync(path.join(ws, "src", "other.ts"), OTHER);
  // Committed, so the rewrite below is a change Source Control lists.
  execSync('git add -A && git commit -qm "baseline"', {
    cwd: ws,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });

  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open File");
  await window.locator("[cmdk-item]", { hasText: "Open File" }).first().click();
  const deskDrawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(deskDrawer).toBeVisible();
  const src = deskDrawer.locator('[data-testid="file-pane-tree-row"][data-kind="dir"][data-path="src"]');
  const deskRow = deskDrawer.locator('[data-testid="file-pane-tree-row"][data-path="src/widget.ts"]');
  if (!(await deskRow.count())) await src.click();
  await deskRow.click();
  await expect(pane(window).locator('[data-testid="file-pane-editor"]')).toContainText("Clicked");

  // ── Pair, open the phone ───────────────────────────────────────────────
  const device = await pairBrowser(window, { label: "file phone" });
  await closeSettings(window);
  const client = await openWebApp(device.link, {
    viewport: { width: 390, height: 844 },
    context: { isMobile: true, hasTouch: true },
  });
  const page = client.page;

  try {
    await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });

    // 1. The file pane's tab is named for its file; picking it shows the file.
    const fileTab = page.locator('[data-testid="tab"]', { hasText: "widget.ts" });
    await expect(fileTab).toBeVisible({ timeout: 15_000 });
    await fileTab.click();
    const editor = pane(page).locator('[data-testid="file-pane-editor"]');
    await expect(editor).toContainText("Clicked", { timeout: 15_000 });

    // 2. Read-only: not contenteditable, so a tap never raises the keyboard,
    // and nothing that implies editing is shown.
    const content = editor.locator(".cm-content");
    await expect(content).toHaveAttribute("contenteditable", "false");
    await content.tap();
    await expect(content).toHaveAttribute("contenteditable", "false");
    await expect(page.locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="file-pane-save-hint"]')).toHaveCount(0);

    // The strip's buttons are finger-sized.
    const filesButton = pane(page).locator('[data-testid="file-pane-files-button"]');
    const box = await filesButton.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(32);
    expect(box?.height).toBeGreaterThanOrEqual(32);
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot(testInfo, "phone-file") });

    // 3. An agent rewrites the file: the phone hears `files.changed` for its
    // own host id and reloads it.
    fs.writeFileSync(widget, WIDGET.replace("Clicked", "Pressed"));
    await expect(editor).toContainText("Pressed", { timeout: 15_000 });
    await expect(editor).not.toContainText("Clicked");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(testInfo, "phone-reloaded") });

    // 4. The Files drawer: wide enough to read, closed by picking a file.
    await filesButton.tap();
    const drawer = pane(page).locator('[data-testid="file-pane-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-testid="file-pane-new-file"]')).toHaveCount(0);
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox?.width).toBeGreaterThanOrEqual(260);
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(390);
    const otherRow = drawer.locator('[data-testid="file-pane-tree-row"][data-path="src/other.ts"]');
    await expect(otherRow).toBeVisible();
    const rowBox = await otherRow.boundingBox();
    expect(rowBox?.height).toBeGreaterThanOrEqual(32);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(testInfo, "phone-drawer") });

    await otherRow.tap();
    await expect(drawer).toBeHidden();
    await expect(editor).toContainText("the other file", { timeout: 15_000 });
    await expect(editor.locator(".cm-content")).toHaveAttribute("contenteditable", "false");

    // 5. Source Control from the overflow menu: it floats over the editor
    // and lists the rewritten file.
    await page.getByTestId("phone-overflow-button").tap();
    await page.getByTestId("phone-overflow-scm").tap();
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("data-mode", "scm");
    const scmRow = drawer.locator('[data-testid="scm-row"][data-path="src/widget.ts"]');
    await expect(scmRow).toHaveAttribute("data-letter", "M", { timeout: 30_000 });
    const scmBox = await drawer.boundingBox();
    const editorBox = await editor.boundingBox();
    expect(scmBox!.x + scmBox!.width).toBeLessThanOrEqual(390);
    // Over the editor, not beside it: the editor starts under the drawer.
    expect(editorBox!.x).toBeLessThan(scmBox!.x + scmBox!.width);
    expect(editorBox!.x + editorBox!.width).toBeGreaterThan(scmBox!.x + scmBox!.width);

    // Git's buttons are there but off. (Their "why" is a hover tooltip, which
    // a touch screen never raises.)
    await expect(scmRow.locator('[data-testid="scm-stage"]')).toHaveAttribute("aria-disabled", "true");
    await expect(scmRow.locator('[data-testid="scm-discard"]')).toHaveAttribute("aria-disabled", "true");
    const commit = drawer.locator('[data-testid="scm-commit"]');
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await expect(drawer.locator('[data-testid="scm-commit-message"]')).toHaveAttribute("readonly", "");
    await expect(drawer.locator('[data-testid="scm-commit-menu"]')).toHaveAttribute("aria-disabled", "true");
    await page.screenshot({ path: shot(testInfo, "phone-scm") });

    // 6. A row shows its diff, read-only; the floating drawer gets out of the way.
    await scmRow.locator("button").first().tap();
    await expect(drawer).toBeHidden();
    await expect(pane(page).locator('[data-testid="file-pane-diff-tag"]')).toHaveText("Diff vs HEAD", {
      timeout: 15_000,
    });
    await expect(editor.locator(".cm-deletedChunk")).toContainText("Clicked");
    const changed = editor.locator(".cm-changedLine", { hasText: "Pressed" });
    await expect(changed).toBeVisible();
    await expect(editor.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(testInfo, "phone-diff") });

    // 7. Selected lines still take a comment: select the changed line (as a
    // long-press would, through the page's selection), then + Comment.
    const chip = page.locator('[data-testid="diff-comment-chip"]');
    await changed.evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const chipShown = await chip
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!chipShown) {
      // A drag across the line, as a mouse would.
      const box = (await changed.boundingBox())!;
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await expect(chip).toBeVisible();
    await chip.tap();
    const composer = editor.locator('[data-testid="diff-comment-composer"]');
    await expect(composer).toContainText("L2");
    await composer.locator("textarea").fill("Why Pressed?");
    await composer.locator('[data-testid="diff-comment-save"]').tap();
    const card = editor.locator('[data-testid="diff-comment-card"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("L2");
    await expect(card).toContainText("Why Pressed?");
    await expect(composer).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(testInfo, "phone-comment") });
  } catch (err) {
    console.log(client.log.join("\n"));
    throw err;
  } finally {
    await client.close();
  }
});
