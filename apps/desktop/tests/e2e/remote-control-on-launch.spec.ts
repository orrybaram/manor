import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, killApp, launchApp } from "./fixtures";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, openRemoteControlSettings } from "./helpers/settings";
import { waitForAppDocument } from "./helpers/window";

/**
 * "Turn on when Manor opens", and the palette's quick switch.
 *
 * The setting is ticked through Settings → Hosts → This Mac like a user
 * would; the app is then quit and started again on the same home, and
 * remote control has to come up — relay running — with nobody touching it.
 * The palette then turns it off and on again with no dialog, a toast saying
 * which each time.
 *
 * Launches its own app instances rather than taking the fixture's, as
 * `agent-rename.spec.ts` does: the fixture owns the shutdown of the app it
 * created, and a restart mid-test needs two.
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
      "",
    ].join("\n"),
  );
}

/** Switch theme, returning the one it replaced so the caller can switch back. */
async function setTheme(window: Page, name: string): Promise<string> {
  const before = await window.evaluate(() => window.electronAPI.theme.getSelectedName());
  await window.evaluate((n) => window.electronAPI.theme.setSelected(n), name);
  await window.waitForTimeout(500);
  return before;
}

function shot(testInfo: TestInfo, name: string): string {
  const dir = process.env.MANOR_E2E_SHOTS ?? testInfo.outputPath();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

async function openPaletteAt(window: Page, query: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  const input = window.locator("[cmdk-input]");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(query);
  // Past the open animation, so a screenshot shows it settled.
  await window.waitForTimeout(400);
}

/** The palette closes as a command runs; wait it out before a screenshot. */
async function paletteGone(window: Page): Promise<void> {
  await expect(window.locator("[cmdk-input]")).toHaveCount(0, { timeout: 5_000 });
  await window.waitForTimeout(300);
}

test("remote control comes back on after a restart when asked to, and the palette flips it", async ({
  tempHome,
  appLaunch,
}, testInfo) => {
  test.setTimeout(240_000);
  installLightTheme(tempHome);

  // ── First run: tick "Turn on when Manor opens", nothing else. ──
  const first = await launchApp(tempHome, appLaunch);
  try {
    const window = await first.firstWindow();
    await waitForAppDocument(window);
    await openRemoteControlSettings(window);
    const card = window.getByTestId("remote-relay-card");
    const onLaunch = window.getByTestId("remote-control-on-launch");
    await expect(onLaunch).toBeEnabled({ timeout: 10_000 });
    await expect(onLaunch).toHaveAttribute("data-state", "unchecked");
    await expect(card).toContainText("Turns off again when Manor quits.");
    await card.screenshot({ path: shot(testInfo, "this-mac-default-dark") });

    await onLaunch.click();
    await expect(onLaunch).toHaveAttribute("data-state", "checked");
    // Ticking it turns nothing on now, and asks nothing.
    await expect(window.getByTestId("remote-relay-confirm")).not.toBeVisible();
    await expect(window.getByTestId("remote-control-switch")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    await expect(card).toContainText("Turns on again next time Manor opens.");
    await card.screenshot({ path: shot(testInfo, "this-mac-on-launch-set-dark") });
    const dark = await setTheme(window, LIGHT_THEME);
    await card.screenshot({ path: shot(testInfo, "this-mac-on-launch-set-light") });
    await setTheme(window, dark);
  } finally {
    await killApp(first);
  }

  // ── Second run: on by itself. ──
  const second = await launchApp(tempHome, appLaunch);
  try {
    const window = await second.firstWindow();
    await waitForAppDocument(window);
    await openRemoteControlSettings(window);
    const card = window.getByTestId("remote-relay-card");
    await expect(card).toContainText("Remote control is on", { timeout: 30_000 });
    await expect(window.getByTestId("remote-control-switch")).toHaveAttribute(
      "data-state",
      "checked",
    );
    await expect(window.getByTestId("remote-control-on-launch")).toHaveAttribute(
      "data-state",
      "checked",
    );
    await card.screenshot({ path: shot(testInfo, "this-mac-after-relaunch-dark") });
    const dark = await setTheme(window, LIGHT_THEME);
    await card.screenshot({ path: shot(testInfo, "this-mac-after-relaunch-light") });
    await setTheme(window, dark);
    await closeSettings(window);

    // ── The palette: off, then on, no dialog either way. ──
    await openPaletteAt(window, "remote control");
    const turnOff = window.locator("[cmdk-item]", { hasText: "Turn Off Remote Control" });
    await expect(turnOff).toBeVisible();
    await window.screenshot({ path: shot(testInfo, "palette-turn-off-dark") });
    await turnOff.click();
    await expect(window.getByTestId("remote-relay-confirm")).not.toBeVisible();
    const toastOff = window.getByText("Remote control is off", { exact: true });
    await expect(toastOff).toBeVisible({ timeout: 10_000 });
    await paletteGone(window);
    await window.screenshot({ path: shot(testInfo, "toast-off-dark") });

    await setTheme(window, LIGHT_THEME);
    await openPaletteAt(window, "remote control");
    const turnOn = window.locator("[cmdk-item]", { hasText: "Turn On Remote Control" });
    await expect(turnOn).toBeVisible();
    await window.screenshot({ path: shot(testInfo, "palette-turn-on-light") });
    await turnOn.click();
    await expect(window.getByTestId("remote-relay-confirm")).not.toBeVisible();
    await expect(window.getByText("Remote control is on", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await paletteGone(window);
    await window.screenshot({ path: shot(testInfo, "toast-on-light") });

    await openRemoteControlSettings(window);
    await expect(window.getByTestId("remote-relay-card")).toContainText(
      "Remote control is on",
      { timeout: 30_000 },
    );
  } finally {
    await killApp(second);
  }
});
