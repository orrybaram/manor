import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { pane } from "./helpers/file-pane";

/**
 * The file pane's Search view (#692): ⌘⇧F opens it from anywhere, with the
 * query focused (and a file pane's one-line selection in it). Typing lists
 * the workspace's matches grouped by file; Case, Word and Regex and the
 * include/exclude globs change them; a click or Enter opens the file with
 * the cursor on the match's line. (`file-pane-search.spec.ts` is the open
 * file's own ⌘F find widget.)
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

const drawer = (window: Page) => pane(window).locator('[data-testid="file-pane-drawer"]');
const input = (window: Page) => pane(window).locator('[data-testid="file-search-input"]');
const summary = (window: Page) => pane(window).locator('[data-testid="file-search-summary"]');
const fileGroups = (window: Page) => pane(window).locator('[data-testid="file-search-file"]');
const match = (window: Page, p: string, line: number) =>
  pane(window).locator(
    `[data-testid="file-search-match"][data-path="${p}"][data-line="${line}"]`,
  );
const toggle = (window: Page, which: "case" | "word" | "regex") =>
  pane(window).locator(`[data-testid="file-search-${which}"]`);
const activeLine = (window: Page) =>
  pane(window).locator(".cm-lineNumbers .cm-activeLineGutter");
const editor = (window: Page) => pane(window).locator('[data-testid="file-pane-editor"]');

test("⌘⇧F opens the Search view; results group by file, toggles and globs narrow them, a result opens at its line", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-search");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  };
  // "needle": 3 in alpha (one capitalised), 1 inside "needles" in beta,
  // 1 in the docs, 1 in the test: 6 results in 4 files.
  write("src/alpha.ts", "export const needle = 1;\nexport const Needle = needle + 1;\n");
  write("src/beta.ts", "// nothing here\n\nexport const needles = [];\n");
  write("docs/notes.md", "A needle in the docs.\n");
  write("src/alpha.test.ts", 'test("needle", () => {});\n');

  // From the terminal, ⌘⇧F opens a file pane on Search, its query focused.
  await window.keyboard.press("ControlOrMeta+Shift+F");
  await expect(drawer(window)).toHaveAttribute("data-mode", "search");
  await expect(drawer(window)).toContainText("Search");
  await expect(input(window)).toBeFocused();
  await expect(pane(window).locator('[data-testid="file-pane-search-button"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Typing lists the matches, grouped by file with counts.
  await window.keyboard.type("needle");
  await expect(summary(window)).toHaveText("6 results in 4 files");
  await expect(fileGroups(window)).toHaveCount(4);
  await expect(
    fileGroups(window).filter({ hasText: "alpha.ts" }).first().locator('[data-testid="file-search-count"]'),
  ).toHaveText("3");
  await expect(match(window, "src/beta.ts", 3).locator("mark")).toHaveText("needle");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("search-dark.png") });

  // Case drops "Needle"; Word, with it, drops "needles".
  await toggle(window, "case").click();
  await expect(toggle(window, "case")).toHaveAttribute("aria-pressed", "true");
  await expect(summary(window)).toHaveText("5 results in 4 files");
  await toggle(window, "word").click();
  await expect(summary(window)).toHaveText("4 results in 3 files");
  await expect(match(window, "src/beta.ts", 3)).toHaveCount(0);
  await toggle(window, "case").click();
  await toggle(window, "word").click();
  await expect(summary(window)).toHaveText("6 results in 4 files");

  // Regex reads the query as a pattern.
  await input(window).fill("need(le|ful)s");
  await toggle(window, "regex").click();
  await expect(summary(window)).toHaveText("1 result in 1 file");
  await expect(match(window, "src/beta.ts", 3)).toBeVisible();
  await toggle(window, "regex").click();
  await input(window).fill("needle");
  await expect(summary(window)).toHaveText("6 results in 4 files");

  // Include and exclude narrow by glob.
  await pane(window).locator('[data-testid="file-search-include"]').fill("src");
  await expect(summary(window)).toHaveText("5 results in 3 files");
  await pane(window).locator('[data-testid="file-search-exclude"]').fill("*.test.ts, docs");
  await expect(summary(window)).toHaveText("4 results in 2 files");

  // A collapsed file keeps its header and hides its lines.
  const alpha = fileGroups(window).filter({ hasText: "alpha.ts" }).first();
  await alpha.click();
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await expect(match(window, "src/alpha.ts", 1)).toHaveCount(0);
  await alpha.click();
  await expect(match(window, "src/alpha.ts", 1)).toBeVisible();

  // A click opens the file with the cursor on the match's line.
  await match(window, "src/beta.ts", 3).click();
  await expect(editor(window)).toContainText("export const needles");
  await expect(activeLine(window)).toHaveText("3");
  await expect(match(window, "src/beta.ts", 3)).toHaveAttribute("aria-selected", "true");

  // ↓ from the query walks the results; Enter opens one.
  await input(window).click();
  await window.keyboard.press("ArrowDown");
  await expect(match(window, "src/alpha.ts", 1)).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("ArrowDown");
  await expect(match(window, "src/alpha.ts", 2)).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(editor(window)).toContainText("export const Needle");
  await expect(activeLine(window)).toHaveText("2");

  // ⌘⇧F in the pane brings the editor's one-line selection along.
  await editor(window).locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+Home");
  await window.keyboard.press("Shift+End");
  await window.keyboard.press("ControlOrMeta+Shift+F");
  await expect(input(window)).toBeFocused();
  await expect(input(window)).toHaveValue("export const needle = 1;");
  await expect(summary(window)).toHaveText("1 result in 1 file");

  // The view keeps its search across a switch to Files and back.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await expect(drawer(window)).toHaveAttribute("data-mode", "files");
  await pane(window).locator('[data-testid="file-pane-search-button"]').click();
  await expect(input(window)).toHaveValue("export const needle = 1;");
  await expect(summary(window)).toHaveText("1 result in 1 file");

  // ⌘F in the editor is still the file's own find.
  await editor(window).locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+f");
  await expect(pane(window).locator('[data-testid="file-pane-find"]')).toBeVisible();
  await expect(drawer(window)).toHaveAttribute("data-mode", "search");
  await window.keyboard.press("Escape");

  // Clear empties the query and the results.
  await pane(window).locator('[data-testid="file-search-clear"]').click();
  await expect(input(window)).toHaveValue("");
  await expect(fileGroups(window)).toHaveCount(0);

  // Light theme: results and highlights read on a light background.
  await input(window).fill("needle");
  await expect(summary(window)).toHaveText("4 results in 2 files");
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .not.toBe("#1e1e2e");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("search-light.png") });
});
