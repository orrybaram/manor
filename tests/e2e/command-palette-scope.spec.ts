import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  test,
} from "./fixtures";

/**
 * The command palette searches the project of the workspace it was opened
 * from, and can be widened to every project (ADR-200). Two projects are
 * seeded so the scope is observable: `test-project` (active, holding
 * `alpha-ws`) and `other-project` (holding `beta-ws`).
 */

const paletteInput = (window: Page) => window.locator("[cmdk-input]");
const chip = (window: Page) =>
  window.locator('[data-testid="palette-scope-chip"]');
const workspaceItems = (window: Page, name: string) =>
  window.locator("[cmdk-item]", { hasText: name });
const groupHeading = (window: Page, name: string) =>
  window.locator("[cmdk-group-heading]", { hasText: name });

async function openPalette(window: Page): Promise<void> {
  await window.keyboard.press("Meta+k");
  await expect(paletteInput(window)).toBeVisible();
}

async function closePalette(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(paletteInput(window)).not.toBeVisible();
}

/** Seed a second git repo and add it through the Add Project dialog. */
async function addSecondProject(
  app: ElectronApplication,
  window: Page,
  tempHome: string,
): Promise<void> {
  const dir = path.join(tempHome, "other-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@manor-e2e.local"', { cwd: dir });
  execSync('git config user.name "Manor E2E"', { cwd: dir });
  execSync("git checkout -b main", { cwd: dir });
  execSync("git add .gitkeep", { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });

  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, dir);

  await window.locator('[data-testid="sidebar-add-project"]').click();
  await window.getByRole("button", { name: /Choose Folder/ }).click();

  const wizard = window.locator('[data-testid="project-setup-wizard"]');
  const skip = wizard.getByRole("button", { name: "Skip", exact: true });
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 5; i++) {
    if (!(await wizard.isVisible())) break;
    await skip.click();
  }
  await expect(wizard).not.toBeVisible({ timeout: 5_000 });
}

test("palette search is scoped to the project and can be widened", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "alpha-ws");
  await addSecondProject(app, window, tempHome);
  await createWorkspace(window, "beta-ws");

  // Return to a workspace of test-project.
  await window
    .locator('[data-testid="workspace-item"]', { hasText: "alpha-ws" })
    .first()
    .click();

  // 1. Scoped to the active workspace's project.
  await openPalette(window);
  await expect(chip(window)).toHaveAttribute("data-scope", "project");
  await expect(chip(window)).toContainText("test-project");
  await expect(paletteInput(window)).toHaveAttribute(
    "placeholder",
    /Search test-project/,
  );
  await expect(groupHeading(window, "test-project")).toBeVisible();
  await expect(groupHeading(window, "other-project")).toHaveCount(0);
  await expect(workspaceItems(window, "beta-ws")).toHaveCount(0);

  // 2. Backspace twice on the empty input widens to all projects.
  await paletteInput(window).press("Backspace");
  await paletteInput(window).press("Backspace");
  await expect(chip(window)).toHaveAttribute("data-scope", "global");
  await expect(chip(window)).toHaveText("All projects");
  await expect(groupHeading(window, "other-project")).toBeVisible();
  await expect(workspaceItems(window, "beta-ws")).toHaveCount(1);

  // 3. Tab toggles back to the project chip.
  await paletteInput(window).press("Tab");
  await expect(chip(window)).toHaveAttribute("data-scope", "project");
  await expect(workspaceItems(window, "beta-ws")).toHaveCount(0);
  await closePalette(window);

  // 4. The sidebar Search row opens globally.
  await window.locator('[data-testid="search-row"]').click();
  await expect(paletteInput(window)).toBeVisible();
  await expect(chip(window)).toHaveAttribute("data-scope", "global");
  await expect(chip(window)).toHaveText("All projects");
  await expect(paletteInput(window)).toHaveAttribute(
    "placeholder",
    /Search all projects/,
  );
  await closePalette(window);

  // 6. A scoped search for the other project's workspace finds nothing here,
  // says so, and Cmd+Enter widens to show it.
  await openPalette(window);
  await expect(chip(window)).toHaveAttribute("data-scope", "project");
  await paletteInput(window).fill("beta-ws");
  await expect(
    window.locator('[data-testid="palette-scope-empty"]'),
  ).toBeVisible();
  await expect(workspaceItems(window, "beta-ws")).toHaveCount(0);
  await expect(
    window.locator('[data-testid="palette-scope-footer"]'),
  ).toBeVisible();
  await paletteInput(window).press("Meta+Enter");
  await expect(chip(window)).toHaveAttribute("data-scope", "global");
  await expect(workspaceItems(window, "beta-ws")).toHaveCount(1);
  await closePalette(window);

  // 5. On the Dashboard the palette opens globally.
  await openPalette(window);
  await paletteInput(window).fill("Dashboard");
  await workspaceItems(window, "Dashboard").first().click();
  await expect(paletteInput(window)).not.toBeVisible();
  await openPalette(window);
  await expect(chip(window)).toHaveAttribute("data-scope", "global");
  await expect(chip(window)).toHaveText("All projects");
  await closePalette(window);
});
