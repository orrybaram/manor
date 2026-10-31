import fs from "fs";
import path from "path";

import type { Page, TestInfo } from "@playwright/test";

import { expect, importSeededProject, test } from "./fixtures";
import { closeSettings, openSettings } from "./helpers/settings";

/**
 * Settings › Theme: the filter rail and swatch wall, Manor's own theme,
 * recents, and a custom theme made, edited, renamed and deleted through the
 * editor, then the project picker listing them. Photographed in a dark and a
 * light theme.
 *
 * A handful of real Ghostty palettes are installed where the theme manager
 * looks, so the wall has dark and light themes to filter. Screenshots go to
 * the test's output dir, and are copied into $SHOT_DIR when it is set.
 */

const GHOSTTY: Record<string, [bg: string, fg: string, palette: string[]]> = {
  Dracula: ["#282a36", "#f8f8f2", ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"]],
  "Catppuccin Latte": ["#eff1f5", "#4c4f69", ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be"]],
  "Gruvbox Dark": ["#282828", "#ebdbb2", ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984"]],
  "GitHub Light": ["#ffffff", "#24292f", ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781"]],
  Nord: ["#2e3440", "#d8dee9", ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"]],
  "Rose Pine Dawn": ["#faf4ed", "#575279", ["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"]],
  "Tokyo Night": ["#1a1b26", "#c0caf5", ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"]],
  "Solarized Light": ["#fdf6e3", "#657b83", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"]],
  Kanagawa: ["#1f1f28", "#dcd7ba", ["#16161d", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#c8c093"]],
  "One Half Light": ["#fafafa", "#383a42", ["#383a42", "#e45649", "#50a14f", "#c18401", "#0184bc", "#a626a4", "#0997b3", "#fafafa"]],
  Monokai: ["#272822", "#f8f8f2", ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2"]],
  "Night Owl": ["#011627", "#d6deeb", ["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff"]],
};
const LIGHT = new Set(["Catppuccin Latte", "GitHub Light", "Rose Pine Dawn", "Solarized Light", "One Half Light"]);

function installGhosttyThemes(tempHome: string): void {
  const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, [bg, fg, palette]] of Object.entries(GHOSTTY)) {
    const body = [
      `background = ${bg}`,
      `foreground = ${fg}`,
      ...[...palette, ...palette].map((c, i) => `palette = ${i}=${c}`),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, name), body);
  }
}

async function shot(window: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await window.waitForTimeout(250);
  await window.screenshot({ path: file, animations: "disabled" });
  const dir = process.env.SHOT_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${name}.png`));
  }
}

function note(testInfo: TestInfo, name: string, text: string): void {
  fs.writeFileSync(testInfo.outputPath(name), text);
  const dir = process.env.SHOT_DIR;
  if (dir) fs.writeFileSync(path.join(dir, name), text);
}

const cssVar = (window: Page, name: string) =>
  window.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const tile = (window: Page, name: string) =>
  window.locator(`[data-testid="theme-tile"][data-theme-name="${name}"]`);

const tileNames = (window: Page) =>
  window
    .getByTestId("theme-tile")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-theme-name") ?? ""));

async function openThemes(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-appearance").click();
  await expect(window.getByTestId("theme-wall")).toBeVisible({ timeout: 5_000 });
  await expect(tile(window, "__manor__")).toBeVisible({ timeout: 10_000 });
}

async function pick(window: Page, name: string): Promise<void> {
  await tile(window, name).click();
  await expect(tile(window, name)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
}

test.describe("Settings › Theme", () => {
  test.setTimeout(300_000);

  test("swatch wall, filters, Manor, recents, custom theme lifecycle, project picker", async ({
    app,
    window,
    tempHome,
  }, testInfo) => {
    installGhosttyThemes(tempHome);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win?.isMaximized()) win.unmaximize();
      win?.setSize(1280, 800);
    });
    await importSeededProject(app, window, tempHome);

    // ── The wall, on the default theme ──
    await openThemes(window);
    await expect(tile(window, "__default__")).toHaveAttribute("aria-selected", "true");
    await expect(window.getByTestId("theme-filter-all")).toHaveAttribute("aria-current", "true");
    await shot(window, testInfo, "01-wall-all-default");

    // ── Manor paints the app soot and bone, with a cyan accent ──
    await pick(window, "__manor__");
    await expect.poll(() => cssVar(window, "--accent")).toBe("#10f9de");
    await expect.poll(() => cssVar(window, "--bg")).toBe("#181616");
    await shot(window, testInfo, "02-manor-selected");
    await closeSettings(window);
    await shot(window, testInfo, "03-manor-app");

    // ── Dark / Light ──
    await openThemes(window);
    await window.getByTestId("theme-filter-light").click();
    const light = await tileNames(window);
    expect(light.sort()).toEqual([...LIGHT].sort());
    await shot(window, testInfo, "04-filter-light");
    await window.getByTestId("theme-filter-dark").click();
    const dark = await tileNames(window);
    expect(dark).toContain("__manor__");
    expect(dark.some((n) => LIGHT.has(n))).toBe(false);
    await shot(window, testInfo, "05-filter-dark");

    // ── Recent: only the theme left on when Settings closes, newest first ──
    await window.getByTestId("theme-filter-all").click();
    await pick(window, "Dracula");
    await pick(window, "Tokyo Night");
    await window.getByTestId("theme-filter-recent").click();
    // Browsing doesn't count: just Manor, kept when Settings last closed.
    await expect.poll(() => tileNames(window)).toEqual(["__manor__"]);
    await shot(window, testInfo, "06a-filter-recent-browsing");
    await closeSettings(window);
    await openThemes(window);
    await window.getByTestId("theme-filter-recent").click();
    await expect.poll(() => tileNames(window)).toEqual(["Tokyo Night", "__manor__"]);
    await shot(window, testInfo, "06-filter-recent");
    await pick(window, "__manor__");
    await window.getByTestId("theme-filter-all").click();

    // ── New theme: a copy of Manor, repainted live, saved to disk ──
    await window.getByTestId("theme-new").click();
    const editor = window.getByTestId("theme-editor");
    await expect(editor).toBeVisible();
    await expect(window.getByTestId("theme-name")).toHaveValue("Manor copy");
    await window.getByTestId("theme-color-background").fill("#1d0f24");
    await window.getByTestId("theme-color-accent").fill("#ff40b4");
    await expect.poll(() => cssVar(window, "--bg")).toBe("#1d0f24");
    await expect.poll(() => cssVar(window, "--accent")).toBe("#ff40b4");
    await window.getByTestId("theme-name").fill("Bruise");
    await shot(window, testInfo, "07-editor-dark");
    await window.getByTestId("theme-save").click();
    await expect(tile(window, "custom:Bruise")).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    const file = path.join(tempHome, ".manor", "themes", "Bruise");
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("background = #1d0f24");
    expect(content).toContain("accent = #ff40b4");
    note(testInfo, "custom-theme-file.txt", `$ cat ~/.manor/themes/Bruise\n${content}`);
    await window.getByTestId("theme-filter-custom").click();
    await expect.poll(() => tileNames(window)).toEqual(["custom:Bruise"]);
    await shot(window, testInfo, "08-filter-yours");

    // ── Edit: rename moves the file and keeps the selection ──
    await tile(window, "custom:Bruise").hover();
    await tile(window, "custom:Bruise").getByTestId("theme-edit").click();
    await expect(window.getByTestId("theme-name")).toHaveValue("Bruise");
    await window.getByTestId("theme-name").fill("Old Bruise");
    await window.getByTestId("theme-save").click();
    await expect(tile(window, "custom:Old Bruise")).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".manor", "themes", "Old Bruise"))).toBe(true);

    // ── Delete the selected theme: back to the default ──
    await tile(window, "custom:Old Bruise").hover();
    await tile(window, "custom:Old Bruise").getByTestId("theme-edit").click();
    await window.getByRole("button", { name: "Delete", exact: true }).first().click();
    await shot(window, testInfo, "09-delete-confirm");
    await window.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(window.getByTestId("theme-editor")).not.toBeVisible({ timeout: 5_000 });
    expect(fs.existsSync(path.join(tempHome, ".manor", "themes", "Old Bruise"))).toBe(false);
    await expect.poll(() => cssVar(window, "--bg")).toBe("#1e1e2e");
    await window.getByTestId("theme-filter-all").click();
    await expect(tile(window, "__default__")).toHaveAttribute("aria-selected", "true");
    await shot(window, testInfo, "10-after-delete");

    // ── A light theme: the wall and the editor, then Cancel restores it ──
    await pick(window, "Catppuccin Latte");
    await expect.poll(() => cssVar(window, "--bg")).toBe("#eff1f5");
    await shot(window, testInfo, "11-wall-all-light");
    await window.getByTestId("theme-filter-recent").click();
    await shot(window, testInfo, "12-filter-recent-light");
    await window.getByTestId("theme-new").click();
    await window.getByTestId("theme-color-accent").fill("#d20f39");
    await expect.poll(() => cssVar(window, "--accent")).toBe("#d20f39");
    await shot(window, testInfo, "13-editor-light");
    await window.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => cssVar(window, "--accent")).toBe("#1e66f5");
    await expect.poll(() => cssVar(window, "--bg")).toBe("#eff1f5");

    // ── Keyboard: arrows move the highlight, Enter picks ──
    await window.getByTestId("theme-filter-all").click();
    await window.getByTestId("theme-wall").focus();
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("Enter");
    const second = (await tileNames(window))[1];
    await expect(tile(window, second)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

    // ── Project picker lists Manor and custom themes ──
    await window.getByTestId("theme-new").click();
    await window.getByTestId("theme-name").fill("Project Ink");
    await window.getByTestId("theme-save").click();
    await expect(tile(window, "custom:Project Ink")).toBeVisible({ timeout: 5_000 });
    await pick(window, "Catppuccin Latte");
    await window.getByRole("button", { name: "test-project", exact: true }).click();
    await window.getByTestId("project-theme-select").click();
    await expect(window.getByRole("option", { name: /Manor/ })).toBeVisible({ timeout: 5_000 });
    await expect(window.getByRole("option", { name: /Project Ink/ })).toBeVisible();
    await shot(window, testInfo, "14-project-picker");

    // ── A project wearing a custom theme follows its rename ──
    await window.getByRole("option", { name: /Project Ink/ }).click();
    await expect(window.getByTestId("project-theme-select")).toContainText("Project Ink");
    await window.getByTestId("settings-nav-appearance").click();
    await window.getByTestId("theme-filter-custom").click();
    await tile(window, "custom:Project Ink").hover();
    await tile(window, "custom:Project Ink").getByTestId("theme-edit").click();
    await window.getByTestId("theme-name").fill("Project Ink Renamed");
    await window.getByTestId("theme-save").click();
    await expect(tile(window, "custom:Project Ink Renamed")).toBeVisible({ timeout: 5_000 });
    await window.getByRole("button", { name: "test-project", exact: true }).click();
    await expect(window.getByTestId("project-theme-select")).toContainText("Project Ink Renamed", {
      timeout: 5_000,
    });
  });

  test("opens with the selected tile in view, arrows pick by row, sort by color", async ({
    app,
    window,
    tempHome,
  }, testInfo) => {
    // A real install's worth of themes, so the wall scrolls a long way.
    installGhosttyThemes(tempHome);
    const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
    for (let i = 0; i < 400; i++) {
      const shade = (20 + (i % 50) * 4).toString(16).padStart(2, "0");
      fs.writeFileSync(
        path.join(dir, `Zz Spectrum ${String(i).padStart(3, "0")}`),
        `background = #${shade}${shade}30\nforeground = #f0f0f0\n`,
      );
    }
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win?.isMaximized()) win.unmaximize();
      win?.setSize(1280, 800);
    });
    await importSeededProject(app, window, tempHome);
    await window.evaluate(() => window.electronAPI.theme.setSelected("Zz Spectrum 399"));

    await openThemes(window);
    const last = tile(window, "Zz Spectrum 399");
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeInViewport();
    // Tiles keep their height and the wall scrolls; they don't squash to fit.
    expect((await last.boundingBox())?.height).toBeGreaterThan(50);
    await shot(window, testInfo, "15-wall-many-themes");

    // Columns as laid out, then one row down from the first tile.
    const columns = await window
      .getByTestId("theme-wall")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBeGreaterThanOrEqual(4);
    // The keyboard picks as it moves: no Enter.
    await window.getByTestId("theme-wall").focus();
    await window.keyboard.press("ArrowDown");
    const names = await tileNames(window);
    await expect(tile(window, names[columns])).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    await window.keyboard.press("ArrowRight");
    await expect(tile(window, names[columns + 1])).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    // The wall itself draws no focus ring; the highlighted tile shows the place.
    expect(
      await window.getByTestId("theme-wall").evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe("none");
    await shot(window, testInfo, "20-keyboard-picks");

    // Hover only highlights.
    await tile(window, names[0]).hover();
    await expect(tile(window, names[columns + 1])).toHaveAttribute("aria-selected", "true");

    // Sort by background colour: greys first, then round the hue wheel.
    await window.getByTestId("theme-sort-menu").click();
    await window.getByTestId("theme-sort-color").click();
    await expect(window.getByTestId("theme-sort-color")).toHaveAttribute("aria-pressed", "true");
    await shot(window, testInfo, "21-sort-menu");
    await window.keyboard.press("Escape");
    await window.getByTestId("theme-wall").focus();
    const byColor = await tileNames(window);
    expect(byColor).not.toEqual(names);
    expect([...byColor].sort()).toEqual([...names].sort());
    await window.getByTestId("theme-wall").evaluate((el) => (el.scrollTop = 0));
    await shot(window, testInfo, "22-sort-by-color");
    // Remembered across opens.
    await closeSettings(window);
    await openThemes(window);
    await window.getByTestId("theme-sort-menu").click();
    await expect(window.getByTestId("theme-sort-color")).toHaveAttribute("aria-pressed", "true");
    await window.getByTestId("theme-sort-name").click();
    await expect.poll(() => tileNames(window)).toEqual(names);
  });

  test("a new theme is named for the pick, not the project's theme under it", async ({
    app,
    window,
    tempHome,
  }, testInfo) => {
    installGhosttyThemes(tempHome);
    await importSeededProject(app, window, tempHome);
    await openThemes(window);
    await window.getByRole("button", { name: "test-project", exact: true }).click();
    await window.getByTestId("project-theme-select").click();
    await window.getByRole("option", { name: /Manor/ }).click();
    await expect(window.getByTestId("project-theme-select")).toContainText("Manor");
    await closeSettings(window);

    await openThemes(window);
    await pick(window, "Catppuccin Latte");
    await window.getByTestId("theme-new").click();
    await expect(window.getByTestId("theme-name")).toHaveValue("Catppuccin Latte copy");
    await shot(window, testInfo, "16-new-from-pick-under-project-theme");
  });
});
