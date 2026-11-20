import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Project Setup's agent list finds CLIs installed in per-user folders
 * (`~/.local/bin`, `~/.opencode/bin`) that aren't on the app's PATH. That is
 * the state a Finder-launched app is in when an installer added those
 * folders in `.zshrc`, which a login shell never reads.
 */

const LIGHT_THEME = "E2E Light";

/** An executable `name` in `dir` that does nothing; discovery only checks it exists. */
function plantCli(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}

function installLightTheme(tempHome: string): void {
  const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
  fs.mkdirSync(dir, { recursive: true });
  const palette = [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ];
  fs.writeFileSync(
    path.join(dir, LIGHT_THEME),
    [...palette.map((c, i) => `palette = ${i}=${c}`), "background = #ffffff", "foreground = #1f2328", ""].join("\n"),
  );
}

function shot(testInfo: TestInfo, name: string): string {
  const dir = process.env.MANOR_E2E_SHOTS ?? testInfo.outputPath();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

async function setTheme(window: Page, name: string): Promise<void> {
  await window.evaluate((n) => window.electronAPI.theme.setSelected(n), name);
  await window.waitForTimeout(500);
}

test("Project Setup lists agents installed only in per-user folders", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  plantCli(path.join(tempHome, ".local", "bin"), "claude");
  plantCli(path.join(tempHome, ".opencode", "bin"), "opencode");
  installLightTheme(tempHome);

  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, path.join(tempHome, "test-project"));
  await window.locator('[data-testid="import-project-button"]').click();

  const wizard = window.getByTestId("project-setup-wizard");
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
  await expect(wizard.getByText("Agent Command")).toBeVisible();

  const claude = wizard.getByRole("button", { name: /Claude Code/ });
  const opencode = wizard.getByRole("button", { name: /OpenCode/ });
  await expect(claude).toBeVisible({ timeout: 30_000 });
  await expect(opencode).toBeVisible();
  // Claude comes first, so it is the preselected command.
  await expect(wizard.locator("input").last()).toHaveValue(
    "claude --dangerously-skip-permissions",
  );

  await wizard.screenshot({ path: shot(testInfo, "agent-step-dark") });
  await setTheme(window, LIGHT_THEME);
  await wizard.screenshot({ path: shot(testInfo, "agent-step-light") });
});
