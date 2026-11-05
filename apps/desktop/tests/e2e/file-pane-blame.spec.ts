import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { header, openFileFromPalette, openFromTree, pane } from "./helpers/file-pane";

/**
 * Inline blame in the file pane (#499): a toggle in the header and the
 * palette, a column grouped by commit, and a commit's details on hover.
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
      "selection-background = #dbe9f9",
      "selection-foreground = #1f2328",
      "",
    ].join("\n"),
  );
}

const shot = (testInfo: TestInfo, name: string) => testInfo.outputPath(`${name}.png`);

const column = (window: Page) => pane(window).locator(".cm-blameGutter");
const toggle = (window: Page) => header(window).locator('[data-testid="file-pane-blame-toggle"]');
const firsts = (window: Page) => column(window).locator(".cm-blameFirst");

function commit(ws: string, file: string, text: string, ...message: string[]): void {
  fs.writeFileSync(path.join(ws, file), text);
  execSync(`git add ${file}`, { cwd: ws });
  const args = message.map((m) => `-m ${JSON.stringify(m)}`).join(" ");
  execSync(`git commit -q ${args}`, {
    cwd: ws,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_AUTHOR_DATE: "2024-03-01T12:00:00Z",
    },
  });
}

async function palette(window: Page, query: string, item: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill(query);
  await window.locator("[cmdk-item]", { hasText: item }).first().click();
}

test("blame shows, follows edits, updates after a commit and stays off where git has nothing", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-blame");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, 'pwd > "$HOME/ws-path"');
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();

  commit(ws, "story.txt", "one\ntwo\n", "Start the story");
  commit(
    ws,
    "story.txt",
    "one\ntwo\nthree\nfour\nfive\n",
    "Finish the story",
    "The body says why the ending changed.",
  );
  fs.writeFileSync(path.join(ws, "draft.txt"), "not in git\n");

  await openFileFromPalette(window);
  await openFromTree(window, ["story.txt"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("three");

  // Off by default, and ready.
  await expect(toggle(window)).toBeEnabled();
  await expect(toggle(window)).toHaveAttribute("aria-pressed", "false");
  await expect(column(window)).toHaveCount(0);

  // On: two groups, one per commit, each named once.
  await toggle(window).click();
  await expect(toggle(window)).toHaveAttribute("aria-pressed", "true");
  await expect(firsts(window)).toHaveCount(2);
  await expect(firsts(window).nth(0)).toContainText("Start the story");
  await expect(firsts(window).nth(0)).toContainText("Ada Lovelace");
  await expect(firsts(window).nth(0)).toContainText("y ago");
  await expect(firsts(window).nth(1)).toContainText("Finish the story");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "blame-on") });

  // Hover: the whole message, the sha and the date. Later lines of a group count.
  const head = execSync("git rev-parse HEAD", { cwd: ws, encoding: "utf8" }).trim();
  const tooltip = window.locator('[data-testid="file-pane-blame-tooltip"]');
  await column(window).locator(".cm-gutterElement").nth(4).hover();
  await expect(tooltip).toContainText("The body says why the ending changed.");
  await expect(tooltip).toContainText(head);
  await expect(tooltip).toContainText("2024");
  await window.screenshot({ path: shot(testInfo, "blame-hover") });
  await editor.locator(".cm-content").hover();
  await expect(tooltip).toHaveCount(0);

  // An unsaved line above: the others keep their commits, moved down.
  await editor.locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+Home");
  await window.keyboard.type("zero\n");
  await expect(firsts(window)).toHaveCount(3);
  await expect(firsts(window).nth(0)).toContainText("Not committed yet");
  await expect(firsts(window).nth(1)).toContainText("Start the story");
  await window.screenshot({ path: shot(testInfo, "blame-unsaved") });

  // Saved, it is still not committed; committed from outside, it says so.
  await window.keyboard.press("ControlOrMeta+s");
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
  await expect(firsts(window).nth(0)).toContainText("Not committed yet");
  execSync("git add story.txt", { cwd: ws });
  execSync('git commit -q -m "Add a prologue"', { cwd: ws });
  await expect(firsts(window).nth(0)).toContainText("Add a prologue", { timeout: 30_000 });

  // The palette toggles it too, and the choice is the app's: it stays off in
  // the next file, and comes back on there when asked.
  await palette(window, "Blame", "Hide Blame");
  await expect(column(window)).toHaveCount(0);
  await expect
    .poll(() => window.evaluate(() => localStorage.getItem("manor:fileBlame")))
    .toBe("0");
  await palette(window, "Blame", "Show Blame");
  await expect(firsts(window).first()).toBeVisible();

  // A file git hasn't got: the toggle stays, disabled, and no column shows.
  await openFromTree(window, ["draft.txt"]);
  await expect(editor).toContainText("not in git");
  await expect(toggle(window)).toBeDisabled();
  await expect(column(window)).toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "blame-untracked") });

  // Committed, it can be blamed without reopening.
  commit(ws, "draft.txt", "not in git\n", "Commit the draft");
  await expect(toggle(window)).toBeEnabled({ timeout: 30_000 });
  await expect(firsts(window).first()).toContainText("Commit the draft", { timeout: 30_000 });

  // Blame git refuses: the note says why, and the editor carries on.
  await openFromTree(window, ["story.txt"]);
  await expect(firsts(window).first()).toBeVisible();
  execSync("git config blame.ignoreRevsFile no-such-file", { cwd: ws });
  fs.appendFileSync(path.join(ws, "story.txt"), "six\n");
  const note = pane(window).locator('[data-testid="file-pane-blame-note"]');
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(column(window)).toHaveCount(0);
  await expect(editor).toContainText("six");
  await window.screenshot({ path: shot(testInfo, "blame-note") });
  execSync("git config --unset blame.ignoreRevsFile", { cwd: ws });
  fs.appendFileSync(path.join(ws, "story.txt"), "seven\n");
  await expect(note).toHaveCount(0, { timeout: 30_000 });

  // In the diff view too: its removed lines take no blame of their own.
  fs.writeFileSync(path.join(ws, "story.txt"), "zero\none\nTWO\nthree\nfour\nfive\n");
  await expect(editor).toContainText("TWO", { timeout: 30_000 });
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await pane(window).locator('[data-testid="file-pane-drawer"]').getByText("story.txt").first().click();
  await expect(pane(window).locator('[data-testid="file-pane-diff-tag"]')).toBeVisible();
  await expect(firsts(window).filter({ hasText: "Not committed yet" }).first()).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "blame-diff") });
  await pane(window).locator('[data-testid="file-pane-open-plain"]').click();

  // Light theme: the column is drawn from the theme's tokens.
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))
    .not.toBe("#1e1e2e");
  await window.waitForTimeout(300);
  await window.screenshot({ path: shot(testInfo, "blame-light") });

  // A narrow window: the column shrinks and the editor stays inside the pane.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 500));
  await window.waitForTimeout(500);
  // A narrow window's drawer floats over the editor: shut it to see the column.
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await expect(pane(window).locator('[data-testid="file-pane-drawer"]')).toHaveCount(0);
  const fits = await window.evaluate(() => {
    const paneEl = [...document.querySelectorAll<HTMLElement>('[data-testid="file-pane"]')].find(
      (el) => el.offsetParent !== null,
    )!;
    const editorEl = paneEl.querySelector<HTMLElement>(".cm-editor")!;
    const gutter = paneEl.querySelector<HTMLElement>(".cm-blameGutter")!;
    const a = editorEl.getBoundingClientRect();
    return {
      inside: a.right <= paneEl.getBoundingClientRect().right + 1,
      gutter: gutter.getBoundingClientRect().width,
      editor: a.width,
    };
  });
  expect(fits.inside).toBe(true);
  expect(fits.gutter).toBeLessThan(fits.editor * 0.5);
  await window.screenshot({ path: shot(testInfo, "blame-narrow") });
});
