import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, paneText, runInTerminal } from "./helpers/terminal";

const MIN = 60_000;

/** Where evidence screenshots land: `MANOR_E2E_SHOTS`, or the test's output dir. */
function shot(testInfo: TestInfo, name: string): string {
  return path.join(process.env.MANOR_E2E_SHOTS ?? testInfo.outputPath(), `${name}.png`);
}

/** Run the renderer on a fake clock from `at`, reloading so every timer uses it. */
async function fakeClock(window: Page, at: Date): Promise<void> {
  await window.clock.install({ time: at });
  await window.reload();
  await expect(window.locator('[data-testid="terminal-pane"]:visible').first()).toBeVisible({
    timeout: 30_000,
  });
}

function tabs(window: Page) {
  return window.locator('[data-testid="tab"]:visible');
}

function dustOf(window: Page, index: number) {
  return tabs(window).nth(index).getByTestId("tab-dust");
}

function cobwebs(window: Page) {
  return window.locator('[data-testid="panel-cobwebs"]:visible');
}

/** Select tab `index`, then let `minutes` pass. */
async function visit(window: Page, index: number, minutes: number): Promise<void> {
  await tabs(window).nth(index).click();
  if (minutes) await window.clock.fastForward(minutes * MIN);
}

/** Drag the mouse across the panel in rows, as someone sweeping webs would. */
async function sweepPanel(window: Page, rows: number): Promise<void> {
  const box = await cobwebs(window).boundingBox();
  if (!box) throw new Error("no cobweb canvas to sweep");
  for (let i = 0; i < rows; i++) {
    const y = box.y + 8 + (i * (box.height - 16)) / Math.max(1, rows - 1);
    await window.mouse.move(box.x + box.width - 4, y);
    await window.mouse.move(box.x + 4, y, { steps: 30 });
  }
}

/**
 * A light theme for the evidence shots: a Ghostty theme file where the
 * app's theme manager looks under its HOME (GitHub Light's palette).
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
    .poll(() => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), {
      timeout: 10_000,
    })
    .not.toBe("#1e1e2e");
}

async function setWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => {
    BrowserWindow.getAllWindows()[0]?.setSize(w, 900);
  }, width);
}

test("tabs left alone gather dust, and their panels open under cobwebs the mouse sweeps away", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(300_000);
  installLightTheme(tempHome);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-cobwebs");
  await fakeClock(window, new Date(2026, 9, 31, 10, 0));

  for (let i = 0; i < 3; i++) await window.keyboard.press("ControlOrMeta+t");
  await expect(tabs(window)).toHaveCount(4);

  // Each tab is aged by when it last left the front: the first tab has been
  // away 61 min when it comes back, the second 21, the third 6, the last 0.
  await visit(window, 1, 40);
  await visit(window, 2, 15);
  await visit(window, 3, 6);
  await visit(window, 0, 0);

  await expect(dustOf(window, 0)).toHaveAttribute("data-tab-dust", "0");
  await expect(dustOf(window, 1)).toHaveAttribute("data-tab-dust", "2");
  await expect(dustOf(window, 2)).toHaveAttribute("data-tab-dust", "1");
  await expect(dustOf(window, 3)).toHaveAttribute("data-tab-dust", "0");

  // Back after an hour: the panel is cobwebbed.
  await expect(cobwebs(window)).toHaveAttribute("data-cobwebs", "webs");
  const strandsAtFirst = Number(await cobwebs(window).getAttribute("data-strands"));
  expect(strandsAtFirst).toBeGreaterThan(1000);
  await window.mouse.move(5, 5);
  await window.waitForTimeout(800);
  await window.locator('[role="tablist"]').first().screenshot({ path: shot(testInfo, "tab-dust-dark") });
  await window.screenshot({ path: shot(testInfo, "webs-level3-dark") });

  // The webs never catch a click or a keystroke.
  const paneId = await activePaneId(window);
  await runInTerminal(window, "echo cobweb-$((40+2))");
  await expect.poll(() => paneText(window, paneId), { timeout: 15_000 }).toContain("cobweb-42");

  // Sweep: threads tear and loose pieces fall away.
  await sweepPanel(window, 3);
  await window.screenshot({ path: shot(testInfo, "wipe-mid-dark") });
  await sweepPanel(window, 16);
  // The pointer stays resting on the panel: the loop still settles and
  // sleeps (that's when it reports the count). A few wisps may cling at the
  // very edges; nearly everything else is gone.
  await expect
    .poll(async () => Number(await cobwebs(window).getAttribute("data-strands")), { timeout: 20_000 })
    .toBeLessThan(strandsAtFirst * 0.05);
  await window.mouse.move(5, 5);
  await window.screenshot({ path: shot(testInfo, "wipe-after-dark") });

  // The third tab, away 6 min: one small web in the top-right corner.
  await visit(window, 2, 0);
  await expect(cobwebs(window)).toHaveAttribute("data-cobwebs", "webs");
  await window.mouse.move(5, 5);
  await window.waitForTimeout(800);
  await window.screenshot({ path: shot(testInfo, "webs-level1-dark") });

  // Straight back to a swept tab: only the leftovers, nothing regrown.
  await visit(window, 3, 1);
  await visit(window, 0, 0);
  expect(Number(await cobwebs(window).getAttribute("data-strands"))).toBeLessThan(strandsAtFirst * 0.05);

  // Light theme, 40 min on: the other tabs have been away 61, 46 and 40 min.
  await useLightTheme(window);
  await window.clock.fastForward(40 * MIN);
  await expect(dustOf(window, 1)).toHaveAttribute("data-tab-dust", "3");
  await expect(dustOf(window, 2)).toHaveAttribute("data-tab-dust", "2");
  await window.waitForTimeout(800);
  await window.locator('[role="tablist"]').first().screenshot({ path: shot(testInfo, "tab-dust-light") });
  await visit(window, 2, 0);
  await expect(cobwebs(window)).toHaveAttribute("data-cobwebs", "webs");
  await window.mouse.move(5, 5);
  await window.waitForTimeout(800);
  await window.screenshot({ path: shot(testInfo, "webs-level2-light") });
  await visit(window, 1, 0);
  await expect(cobwebs(window)).toHaveAttribute("data-cobwebs", "webs");
  await window.mouse.move(5, 5);
  await window.waitForTimeout(800);
  await window.screenshot({ path: shot(testInfo, "webs-level3-light") });

  // A browser tab gathers dust like any other, but never webs.
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
  const browserIndex = (await tabs(window).count()) - 1;
  await visit(window, 0, 10);
  await expect(dustOf(window, browserIndex)).toHaveAttribute("data-tab-dust", "1");
  await visit(window, browserIndex, 0);
  await expect(window.locator("webview:visible")).toHaveCount(1);
  await expect(cobwebs(window)).toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "browser-tab-no-webs-light") });

  // The phone layout shows none of it.
  await visit(window, 0, 10);
  await setWidth(app, 600);
  await expect(window.locator(".app[data-layout='phone']")).toHaveCount(1, { timeout: 10_000 });
  await expect(window.getByTestId("tab-dust")).toHaveCount(0);
  await expect(window.getByTestId("panel-cobwebs")).toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "phone-nothing-light") });
  await setWidth(app, 1400);
  await expect(window.locator(".app[data-layout='desk']")).toHaveCount(1, { timeout: 10_000 });
  await expect(window.getByTestId("tab-dust").first()).toBeAttached();

  // Turning the setting off clears everything at once.
  await window.keyboard.press("ControlOrMeta+,");
  await window.getByRole("button", { name: "Appearance" }).click();
  const toggle = window.getByRole("switch").last();
  await toggle.scrollIntoViewIfNeeded();
  await expect(window.getByText("Halloween effects")).toBeVisible();
  await window.screenshot({ path: shot(testInfo, "setting-light") });
  await toggle.click();
  await expect(window.getByTestId("tab-dust")).toHaveCount(0);
  await expect(window.getByTestId("panel-cobwebs")).toHaveCount(0);
  await toggle.click();
  await expect(window.getByTestId("tab-dust").first()).toBeAttached();
});

test("outside Halloween week, tabs stay clean", async ({ app, window, tempHome }) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-no-cobwebs");
  await fakeClock(window, new Date(2026, 9, 20, 10, 0));
  await window.keyboard.press("ControlOrMeta+t");
  await expect(tabs(window)).toHaveCount(2);
  await visit(window, 1, 90);
  await visit(window, 0, 0);
  await expect(window.getByTestId("tab-dust")).toHaveCount(0);
  await expect(window.getByTestId("panel-cobwebs")).toHaveCount(0);
});
