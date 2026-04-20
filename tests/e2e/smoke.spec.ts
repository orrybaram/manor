import path from "path";
import { expect, test } from "./fixtures";

test("pane lifecycle", async ({ app, window, tempHome }) => {
  const seededProjectPath = path.join(tempHome, "test-project");

  // Step b: Dismiss project-setup-wizard if it appears on fresh launch.
  // On a fresh launch with no projects, the wizard should NOT appear —
  // it only shows after importing a project. So we proceed to import first.

  // Step c: Stub dialog.showOpenDialog before clicking import-project-button.
  // The WelcomeEmptyState calls window.electronAPI.dialog.openDirectory()
  // which invokes dialog:openDirectory IPC → dialog.showOpenDialog in main.
  await app.evaluate(
    ({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [projectPath],
      });
    },
    seededProjectPath,
  );

  // Click the import-project-button (the drop zone / "Open Project" button).
  await window.locator('[data-testid="import-project-button"]').click();

  // After import, the project-setup-wizard appears. Dismiss it by clicking
  // "Skip" repeatedly until the wizard closes (Skip on last step calls onClose).
  // The wizard has up to 4 steps (no Linear in test env).
  const wizard = window.locator('[data-testid="project-setup-wizard"]');
  const skipButton = wizard.getByRole("button", { name: "Skip", exact: true });

  // Wait for wizard to appear
  await expect(wizard).toBeVisible({ timeout: 10_000 });

  // Skip through all wizard steps (4 steps without Linear).
  // Each click of Skip either advances to next step or closes on last step.
  for (let i = 0; i < 5; i++) {
    const isVisible = await wizard.isVisible();
    if (!isVisible) break;
    await skipButton.click();
  }

  // Wizard should be gone now
  await expect(wizard).not.toBeVisible({ timeout: 5_000 });

  // Step d: Click sidebar-new-workspace-button for the imported project.
  await window.locator('[data-testid="sidebar-new-workspace-button"]').click();

  // Step e: Wait for the new-workspace-dialog to be visible.
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Step f: Fill the workspace name input.
  const nameInput = window.locator('[data-testid="new-workspace-name-input"]');
  await nameInput.fill("smoke-test-workspace");

  // Step g: Leave project / base branch at defaults — they should already be
  // populated with the imported project and its default branch ("main").
  // No action needed unless they're empty, which won't happen for our seeded repo.

  // Step h: Click new-workspace-submit to create the workspace.
  await window.locator('[data-testid="new-workspace-submit"]').click();

  // After workspace creation, the dialog closes and the new workspace is selected
  // but no terminal tab is opened automatically (no agentCommand or startScript).
  // The WorkspaceEmptyState is shown. Wait for the dialog to close, then open a
  // new terminal tab via the "new-tab" keybinding (Meta+T).
  await expect(
    window.locator('[data-testid="new-workspace-dialog"]'),
  ).not.toBeVisible({ timeout: 10_000 });

  // Open a new terminal tab in the new workspace.
  await window.keyboard.press("Meta+t");

  // Step i: Wait for a terminal-pane to appear. Generous 30s timeout because
  // the daemon has to boot on first terminal.
  const terminalPane = window.locator('[data-testid="terminal-pane"]');
  await expect(terminalPane).toBeVisible({ timeout: 30_000 });

  // Step j: Assert there is exactly 1 workspace-pane.
  await expect
    .poll(() => window.locator('[data-testid="workspace-pane"]').count(), {
      timeout: 5_000,
    })
    .toBe(1);

  // Step k: Trigger split-panel-right via keyboard shortcut.
  // Binding: split-panel-right → Meta+Alt+\ (Cmd+Alt+Backslash on macOS)
  await window.keyboard.press("Meta+Alt+\\");

  // Step l: Assert workspace-pane count is now 2 (poll up to 5s).
  await expect
    .poll(() => window.locator('[data-testid="workspace-pane"]').count(), {
      timeout: 5_000,
    })
    .toBe(2);

  // Step m: Close the active pane via the close-pane keyboard shortcut.
  // Binding: close-pane → Meta+w (Cmd+W on macOS)
  // No agent is running so CloseAgentPaneDialog should not appear.
  await window.keyboard.press("Meta+w");

  // Step n: Assert workspace-pane count is back to 1.
  await expect
    .poll(() => window.locator('[data-testid="workspace-pane"]').count(), {
      timeout: 5_000,
    })
    .toBe(1);
});
