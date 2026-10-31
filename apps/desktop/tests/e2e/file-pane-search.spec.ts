import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane } from "./helpers/file-pane";

/**
 * The file pane's find widget: ⌘F floats it over the editor's top right,
 * counts the matches, steps through them, toggles case, word and regex, and
 * replaces.
 */

// "count" twice a line: once inside a name, once as a whole word.
const SOURCE =
  Array.from({ length: 30 }, (_, i) => `export const count${i} = ${i}; // count it`).join("\n") + "\n";

test("⌘F in the file pane finds, counts, toggles and replaces", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-find");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.writeFileSync(path.join(ws, "counts.ts"), SOURCE);

  await openFileFromPalette(window);
  await openFromTree(window, ["counts.ts"]);
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(editor).toContainText("count29");
  await editor.locator(".cm-content").click();

  await window.keyboard.press("ControlOrMeta+f");
  const find = pane(window).locator('[data-testid="file-pane-find"]');
  const field = find.getByRole("textbox", { name: "Find" });
  const count = find.locator('[data-testid="file-pane-find-count"]');
  await expect(field).toBeFocused();
  await window.keyboard.type("count");
  await expect(count).toHaveText("60 found");

  // From the top, Enter steps onto a match and the count says which.
  await editor.locator(".cm-line").first().click({ position: { x: 1, y: 5 } });
  await field.focus();
  await window.keyboard.press("Enter");
  await expect(count).toHaveText("1 of 60");
  await window.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 60");
  await window.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("1 of 60");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("find-dark.png") });

  // Whole word leaves the comments' "count" only.
  await find.getByRole("button", { name: "Match Whole Word" }).click();
  await expect(find.getByRole("button", { name: "Match Whole Word" })).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(/ of 30$|^30 found$/);
  await expect(field).toBeFocused();

  // A broken regex says so instead of searching.
  await find.getByRole("button", { name: "Match Whole Word" }).click();
  await find.getByRole("button", { name: "Use Regular Expression" }).click();
  await field.fill("count(");
  await expect(count).toHaveText("Invalid");
  await field.fill("count\\d+");
  await expect(count).toHaveText(/ of 30$|^30 found$/);
  await find.getByRole("button", { name: "Use Regular Expression" }).click();

  // The chevron opens replace; Replace All rewrites every match.
  await field.fill("count");
  await find.getByRole("button", { name: "Toggle Replace" }).click();
  const replace = find.getByRole("textbox", { name: "Replace" });
  await expect(replace).toBeFocused();
  await replace.fill("tally");
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("replace-dark.png") });
  await useLightTheme(window);
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("replace-light.png") });
  await find.getByRole("button", { name: "Replace All" }).click();
  await expect(editor).toContainText("export const tally29 = 29; // tally it");
  await expect(count).toHaveText("No results");

  // Escape closes it and hands the keyboard back to the editor.
  await field.focus();
  await window.keyboard.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(editor.locator(".cm-content")).toBeFocused();
});

const bg = (window: Page) =>
  window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());

/** Switch to the first built-in theme with a light background. */
async function useLightTheme(window: Page): Promise<void> {
  const before = await bg(window);
  await window.evaluate(async () => {
    const all = await window.electronAPI.theme.allColors();
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const light = Object.entries(all)
      .filter(([, c]) => luminance(c.background) > 0.7)
      .map(([name]) => name)
      .sort()[0];
    if (!light) throw new Error("no light theme to switch to");
    await window.electronAPI.theme.setSelected(light);
  });
  await expect.poll(() => bg(window), { timeout: 10_000 }).not.toBe(before);
}
