import fs from "fs";
import path from "path";

import type { Page, TestInfo } from "@playwright/test";

import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { closeSettings, openSettings } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane } from "./helpers/file-pane";
import { useTheme } from "./helpers/theme";

/**
 * Settings › Font: the installed monospace fonts listed, and a terminal and
 * the file editor redrawn in the family and size picked, the terminal's shell
 * told its new grid. Photographed dark and light; screenshots go to the
 * test's output dir, and to $SHOT_DIR when it is set.
 */

async function shot(window: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await window.waitForTimeout(300);
  await window.screenshot({ path: file, animations: "disabled" });
  const dir = process.env.SHOT_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${name}.png`));
  }
}

async function openFontSettings(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-appearance").click();
  await window.getByTestId("editor-font").scrollIntoViewIfNeeded();
  await expect(window.getByTestId("terminal-font")).toBeVisible();
}

/** Pick `family` from a font row's searchable list. */
async function pickFamily(window: Page, row: string, family: string): Promise<void> {
  await window.getByTestId(`${row}-family`).click();
  await window.getByPlaceholder("Search fonts...").fill(family);
  await window.locator("#searchable-select-listbox").getByRole("option", { name: family, exact: true }).click();
  await expect(window.getByTestId(`${row}-family`)).toContainText(family);
}

async function setSize(window: Page, row: string, from: number, to: number): Promise<void> {
  const label = row === "terminal-font" ? "terminal" : "editor";
  const button = window.getByRole("button", {
    name: `${to > from ? "Larger" : "Smaller"} ${label} font`,
  });
  for (let i = 0; i < Math.abs(to - from); i++) await button.click();
  await expect(window.getByTestId(`${row}-size`)).toContainText(`${to} px`);
}

/** What the pane's shell sees: `stty size`, as "rows cols". */
async function sttySize(window: Page, tempHome: string, tag: string): Promise<string> {
  const out = path.join(tempHome, `stty-${tag}`);
  await runInTerminal(window, `stty size > "${out}"`);
  await expect.poll(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").trim()).toBeTruthy();
  return fs.readFileSync(out, "utf8").trim();
}

const terminalOptions = (window: Page, paneId: string) =>
  window.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal ${id}`);
    const { fontFamily, fontSize } = handle.term.options;
    return { fontFamily, fontSize, rows: handle.term.rows, cols: handle.term.cols };
  }, paneId);

/**
 * How far each of the first three line numbers sits from its line, as a
 * share of the line height: the same at any size while CodeMirror's measure
 * is current, off once it is stale.
 */
const gutterOffsets = (window: Page) =>
  pane(window).evaluate((root) => {
    const lines = [...root.querySelectorAll(".cm-content .cm-line")];
    const numbers = [...root.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].filter(
      (el) =>
        /^\d+$/.test(el.textContent ?? "") && getComputedStyle(el).visibility !== "hidden",
    );
    return lines.slice(0, 3).map((line, i) => {
      const l = line.getBoundingClientRect();
      const n = numbers[i].getBoundingClientRect();
      return Math.round(((l.top - n.top) / l.height) * 10) / 10;
    });
  });

test("Settings › Font redraws terminals and the editor in the chosen font", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(240_000);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMaximized()) win.unmaximize();
    win?.setSize(1280, 820);
  });
  await useTheme(window, "Catppuccin Mocha");
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-fonts");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  // ── Defaults: today's terminal ──
  const before = await terminalOptions(window, termId);
  expect(before.fontSize).toBe(13);
  expect(before.fontFamily).toMatch(/^'MesloLGM Nerd Font Mono'/);
  const sizeBefore = await sttySize(window, tempHome, "before");
  await runInTerminal(window, "clear; echo 'The quick brown fox  0O 1lI  {}[]()  →  '");
  await shot(window, testInfo, "01-terminal-default");

  // ── The section, at defaults ──
  await openFontSettings(window);
  await expect(window.getByTestId("terminal-font-family")).toContainText("Default (MesloLGM Nerd Font)");
  await expect(window.getByTestId("editor-font-family")).toContainText("Default (system monospace)");
  await shot(window, testInfo, "02-settings-default-dark");

  // ── The list: installed monospace fonts, Default first ──
  await window.getByTestId("terminal-font-family").click();
  const options = window.locator("#searchable-select-listbox").getByRole("option");
  await expect(options.first()).toContainText("Default (MesloLGM Nerd Font)");
  await expect.poll(() => options.count(), { timeout: 10_000 }).toBeGreaterThan(2);
  const listed = await options.allTextContents();
  expect(listed).toContain("Courier New");
  expect(listed).not.toContain("Helvetica");
  await shot(window, testInfo, "03-family-list");
  await window.getByPlaceholder("Search fonts...").fill("cour");
  await shot(window, testInfo, "04-family-search");
  await window.keyboard.press("Escape");

  // ── Pick a terminal font and size ──
  await pickFamily(window, "terminal-font", "Courier New");
  await setSize(window, "terminal-font", 13, 18);
  await pickFamily(window, "editor-font", "Andale Mono");
  await setSize(window, "editor-font", 12, 16);
  await shot(window, testInfo, "05-settings-chosen-dark");

  await useTheme(window, "Catppuccin Latte");
  await shot(window, testInfo, "06-settings-chosen-light");
  await useTheme(window, "Catppuccin Mocha");
  await closeSettings(window);

  // ── Open terminal redrew, and its shell was told the new grid ──
  await expect.poll(async () => (await terminalOptions(window, termId)).fontSize).toBe(18);
  const after = await terminalOptions(window, termId);
  expect(after.fontFamily).toMatch(/^"Courier New", 'MesloLGM Nerd Font Mono'/);
  await expect
    .poll(async () => (await terminalOptions(window, termId)).cols, { timeout: 10_000 })
    .toBeLessThan(before.cols);
  const grid = await terminalOptions(window, termId);
  const sizeAfter = await sttySize(window, tempHome, "after");
  expect(sizeAfter).toBe(`${grid.rows} ${grid.cols}`);
  expect(sizeAfter).not.toBe(sizeBefore);
  await runInTerminal(window, "clear; echo 'The quick brown fox  0O 1lI  {}[]()  →  '");
  await shot(window, testInfo, "07-terminal-chosen");
  fs.writeFileSync(
    testInfo.outputPath("stty.txt"),
    `before: ${sizeBefore} (13px Meslo)\nafter:  ${sizeAfter} (18px Courier New)\n`,
  );

  // ── Editor redrew ──
  await runInTerminal(window, `pwd > "${path.join(tempHome, "ws-path")}"`);
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.writeFileSync(
    path.join(ws, "fonts.ts"),
    "export function terminalOptions() {\n  return { fontSize: 13 };\n}\n",
  );
  await openFileFromPalette(window);
  await openFromTree(window, ["fonts.ts"]);
  const content = pane(window).locator(".cm-content");
  await expect(content).toContainText("terminalOptions");
  const editorFont = await content.evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, size: s.fontSize };
  });
  expect(editorFont.size).toBe("16px");
  const fresh = await gutterOffsets(window);
  expect(editorFont.family).toMatch(/^"Andale Mono"/);
  await shot(window, testInfo, "08-editor-chosen-dark");
  await useTheme(window, "Catppuccin Latte");
  await shot(window, testInfo, "09-editor-chosen-light");

  // ── An editor already open re-measures: line numbers stay beside their lines ──
  await useTheme(window, "Catppuccin Mocha");
  await openFontSettings(window);
  await setSize(window, "editor-font", 16, 22);
  await closeSettings(window);
  await expect.poll(() => content.evaluate((el) => getComputedStyle(el).fontSize)).toBe("22px");
  await expect.poll(() => gutterOffsets(window)).toEqual(fresh);
  await shot(window, testInfo, "10-editor-resized-open");

  // ── Saved with the other preferences ──
  const prefs = await window.evaluate(() => window.electronAPI.preferences.getAll());
  expect(prefs).toMatchObject({
    terminalFontFamily: "Courier New",
    terminalFontSize: 18,
    editorFontFamily: "Andale Mono",
    editorFontSize: 22,
  });
  fs.writeFileSync(
    testInfo.outputPath("preferences.json"),
    JSON.stringify(
      {
        terminalFontFamily: prefs.terminalFontFamily,
        terminalFontSize: prefs.terminalFontSize,
        editorFontFamily: prefs.editorFontFamily,
        editorFontSize: prefs.editorFontSize,
      },
      null,
      2,
    ),
  );
});
