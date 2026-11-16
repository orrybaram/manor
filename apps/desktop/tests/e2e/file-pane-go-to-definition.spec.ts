import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane } from "./helpers/file-pane";

/**
 * Go to Definition and Find Usages in the file pane's editor (#693): F12 or
 * ⌘-click (Ctrl-click off a Mac) on an identifier searches the workspace for
 * its definition. One opens at its line; several fill the Search view as
 * "Definitions of X" (the ranked hits, the name lit); none says so in a toast. ⇧F12 lists its whole-word
 * usages as "Usages of X". Holding the modifier underlines the identifier
 * under the pointer, and both are in the editor's right-click menu.
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

/** ⌘ on a Mac, Ctrl elsewhere: what makes a click Go to Definition. */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const editor = (window: Page) => pane(window).locator('[data-testid="file-pane-editor"]');
const breadcrumb = (window: Page) => pane(window).locator('[data-testid="file-pane-breadcrumb"]');
const activeLine = (window: Page) =>
  pane(window).locator(".cm-lineNumbers .cm-activeLineGutter");
const drawer = (window: Page) => pane(window).locator('[data-testid="file-pane-drawer"]');
const label = (window: Page) => pane(window).locator('[data-testid="file-search-label"]');
const summary = (window: Page) => pane(window).locator('[data-testid="file-search-summary"]');
const fileGroups = (window: Page) => pane(window).locator('[data-testid="file-search-file"]');
const menu = (window: Page) => window.locator('[data-testid="file-pane-editor-menu"]');

/**
 * The middle of `word`'s `nth` occurrence (0-based) on the editor's line
 * `line` (1-based), in window coordinates, found in the rendered text.
 */
async function wordAt(window: Page, line: number, word: string, nth = 0) {
  const box = await editor(window)
    .locator(".cm-line")
    .nth(line - 1)
    .evaluate(
      (el, { word, nth }) => {
        const text = el.textContent ?? "";
        let at = -1;
        for (let i = 0; i <= nth; i++) at = text.indexOf(word, at + 1);
        if (at < 0) return null;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let seen = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const len = node.textContent?.length ?? 0;
          if (at < seen + len) {
            const range = document.createRange();
            const start = at - seen;
            range.setStart(node, start);
            range.setEnd(node, Math.min(len, start + Math.ceil(word.length / 2)));
            const r = range.getBoundingClientRect();
            return { x: r.right, y: r.top + r.height / 2 };
          }
          seen += len;
        }
        return null;
      },
      { word, nth },
    );
  if (!box) throw new Error(`"${word}" not on line ${line}`);
  return box;
}

/** Put the cursor inside `word` on `line` with a plain click. */
async function clickWord(window: Page, line: number, word: string, nth = 0) {
  const { x, y } = await wordAt(window, line, word, nth);
  await window.mouse.click(x, y);
}

/** Open `rel` in the pane from the Files drawer, its text showing. */
async function openFile(window: Page, rel: string, text: string) {
  await openFromTree(window, rel.split("/"));
  await expect(breadcrumb(window)).toContainText(path.basename(rel));
  await expect(editor(window)).toContainText(text);
}

test("F12 and ⌘-click go to a definition, several list as Definitions of X, ⇧F12 lists usages, and the right-click menu offers both", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-definition");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  };
  // formatTotal: one definition (util.ts:3), four whole-word uses in two files.
  // render: two definitions, one in each view.ts.
  write(
    "src/util.ts",
    "// helpers\n\nexport function formatTotal(n: number) {\n  return n.toFixed(2);\n}\n",
  );
  write(
    "src/main.ts",
    [
      'import { formatTotal } from "./util";',
      'import { render } from "./view";',
      "",
      "export const total = formatTotal(3);",
      "render(total);",
      "render(formatTotal(4));",
      "",
    ].join("\n"),
  );
  write("src/view.ts", "export function render(x: unknown) {\n  console.log(x);\n}\n");
  // A decoy: "renderer" is neither a definition nor a whole-word use of render.
  write("src/renderer.ts", "export const renderer = 1; // renderer\n");
  write("src/legacy/view.ts", "export function render(x: unknown) {\n  return String(x);\n}\n");

  await openFileFromPalette(window);
  await openFile(window, "src/main.ts", "export const total");

  // F12 on a call jumps to its one definition, in another file, at its line.
  await clickWord(window, 4, "formatTotal");
  await window.keyboard.press("F12");
  await expect(breadcrumb(window)).toContainText("util.ts");
  await expect(editor(window)).toContainText("export function formatTotal");
  await expect(activeLine(window)).toHaveText("3");
  await expect(editor(window).locator(".cm-content")).toBeFocused();

  // Holding the modifier underlines the identifier under the pointer, and a
  // click there goes to its definition without adding a cursor.
  await openFile(window, "src/main.ts", "export const total");
  const call = await wordAt(window, 6, "formatTotal");
  await window.mouse.move(call.x, call.y);
  await window.keyboard.down(MOD);
  await window.mouse.move(call.x + 1, call.y);
  const link = editor(window).locator(".cm-nav-link");
  await expect(link).toHaveText("formatTotal");
  await window.waitForTimeout(200);
  await window.screenshot({ path: testInfo.outputPath("underline-dark.png") });
  await window.mouse.click(call.x + 1, call.y);
  await window.keyboard.up(MOD);
  await expect(breadcrumb(window)).toContainText("util.ts");
  await expect(activeLine(window)).toHaveText("3");
  // Letting go of the modifier takes the underline away.
  await expect(link).toHaveCount(0);

  // A word with no definition says so.
  await clickWord(window, 4, "toFixed");
  await window.keyboard.press("F12");
  await expect(
    window.locator('[data-testid="toast"]', { hasText: "No definition found for toFixed" }),
  ).toBeVisible();
  await expect(breadcrumb(window)).toContainText("util.ts");

  // The blank past a line's end is no identifier: no underline, and a
  // modifier-click there is a plain click (this editor keeps one selection),
  // which goes nowhere.
  await openFile(window, "src/main.ts", "export const total");
  await clickWord(window, 5, "render");
  const line5 = (await editor(window).locator(".cm-line").nth(4).boundingBox())!;
  const blank = { x: line5.x + line5.width - 8, y: line5.y + line5.height / 2 };
  await window.mouse.move(blank.x, blank.y);
  await window.keyboard.down(MOD);
  await window.mouse.move(blank.x - 1, blank.y);
  await expect(link).toHaveCount(0);
  await window.mouse.click(blank.x - 1, blank.y);
  await window.keyboard.up(MOD);
  await expect(breadcrumb(window)).toContainText("main.ts");
  await expect(editor(window).locator(".cm-cursorLayer .cm-cursor")).toHaveCount(1);
  await expect(activeLine(window)).toHaveText("5");

  // Two definitions fill the Search view, labelled, with the word in the
  // query box and the name lit in each line: the ranked hits, not a search.
  await clickWord(window, 5, "render");
  await window.keyboard.press("F12");
  await expect(drawer(window)).toHaveAttribute("data-mode", "search");
  await expect(label(window)).toHaveText("Definitions of render");
  await expect(summary(window)).toHaveText("2 results in 2 files");
  await expect(fileGroups(window)).toHaveCount(2);
  await expect(pane(window).locator('[data-testid="file-search-input"]')).toHaveValue("render");
  const definitionLines = pane(window).locator('[data-testid="file-search-match"]');
  await expect(definitionLines).toHaveCount(2);
  await expect(definitionLines.locator("mark")).toHaveText(["render", "render"]);
  await expect(pane(window).locator('[data-testid="file-search-refresh"]')).toHaveCount(0);
  await expect(breadcrumb(window)).toContainText("main.ts");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("definitions-dark.png") });
  // A line opens its file with the cursor on the name.
  await pane(window)
    .locator('[data-testid="file-search-match"][data-path="src/legacy/view.ts"]')
    .click();
  await expect(breadcrumb(window)).toContainText("legacy");
  await expect(editor(window)).toContainText("return String(x)");
  await expect(activeLine(window)).toHaveText("1");
  await openFile(window, "src/main.ts", "export const total");

  // ⇧F12 lists the whole-word usages.
  await clickWord(window, 4, "formatTotal");
  await window.keyboard.press("Shift+F12");
  await expect(label(window)).toHaveText("Usages of formatTotal");
  await expect(summary(window)).toHaveText("4 results in 2 files");

  // The right-click menu offers both, for the word clicked.
  await clickWord(window, 5, "total");
  const onRender = await wordAt(window, 6, "render");
  await window.mouse.click(onRender.x, onRender.y, { button: "right" });
  await expect(menu(window)).toBeVisible();
  await expect(menu(window).locator('[data-testid="file-pane-editor-go-to-definition"]')).toContainText(
    "Go to Definition",
  );
  await expect(menu(window).locator('[data-testid="file-pane-editor-find-usages"]')).toContainText(
    "Find Usages",
  );
  await window.waitForTimeout(200);
  await window.screenshot({ path: testInfo.outputPath("menu-dark.png") });
  await menu(window).locator('[data-testid="file-pane-editor-find-usages"]').click();
  await expect(menu(window)).toBeHidden();
  await expect(label(window)).toHaveText("Usages of render");
  await expect(summary(window)).toHaveText("5 results in 3 files");

  const onFormat = await wordAt(window, 6, "formatTotal");
  await window.mouse.click(onFormat.x, onFormat.y, { button: "right" });
  await menu(window).locator('[data-testid="file-pane-editor-go-to-definition"]').click();
  await expect(breadcrumb(window)).toContainText("util.ts");
  await expect(activeLine(window)).toHaveText("3");

  // Light theme: the underline and the Definitions list read on a light background.
  await window.evaluate((name) => window.electronAPI.theme.setSelected(name), LIGHT_THEME);
  await expect
    .poll(() =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .not.toBe("#1e1e2e");
  await openFile(window, "src/main.ts", "export const total");
  const again = await wordAt(window, 5, "render");
  await window.mouse.move(again.x, again.y);
  await window.keyboard.down(MOD);
  await window.mouse.move(again.x + 1, again.y);
  await expect(link).toHaveText("render");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("underline-light.png") });
  await window.mouse.click(again.x + 1, again.y);
  await window.keyboard.up(MOD);
  await expect(label(window)).toHaveText("Definitions of render");
  await expect(summary(window)).toHaveText("2 results in 2 files");
  await expect(pane(window).locator('[data-testid="file-search-input"]')).toHaveValue("render");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("definitions-light.png") });
});
