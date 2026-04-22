import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  _electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const repoRoot = path.join(__dirname, "../..");

export const test = base.extend<{
  app: ElectronApplication;
  window: Page;
  tempHome: string;
}>({
  // eslint-disable-next-line no-empty-pattern
  tempHome: async ({}, use) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-"));

    // Seed a real git repo so tests that create workspaces have a project to target
    const projectDir = path.join(tempHome, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".gitkeep"), "");

    execSync("git init", { cwd: projectDir });
    execSync('git config user.email "test@manor-e2e.local"', {
      cwd: projectDir,
    });
    execSync('git config user.name "Manor E2E"', { cwd: projectDir });
    execSync("git checkout -b main", { cwd: projectDir });
    execSync("git add .gitkeep", { cwd: projectDir });
    execSync('git commit -m "initial commit"', { cwd: projectDir });

    await use(tempHome);

    fs.rmSync(tempHome, { recursive: true, force: true });
  },

  app: async ({ tempHome }, use) => {
    const app = await _electron.launch({
      args: [path.join(repoRoot, "dist-electron/main.js")],
      env: { ...process.env, HOME: tempHome },
      cwd: repoRoot,
    });

    await use(app);

    // app.close() hangs because Manor's detached child processes (terminal-host,
    // spawned with stdio:["ignore","ignore","inherit"]) keep the Electron stderr
    // pipe open. Playwright waits for the 'close' event (all stdio closed) before
    // resolving its gracefullyCloseSet entry. We work around this by:
    //   1. Destroying the piped stdio streams directly so Node emits 'close'.
    //   2. Killing the Electron process group.
    const electronProcess = app.process();
    const pid = electronProcess.pid;

    const closed = new Promise<void>((resolve) => {
      if (electronProcess.exitCode !== null || electronProcess.signalCode !== null) {
        // Already exited — resolve immediately after current tick so Playwright's
        // own 'close' listener (registered before ours) has had a chance to run.
        setImmediate(resolve);
      } else {
        electronProcess.once("close", () => setImmediate(resolve));
      }
    });

    // Destroy the stdio streams to force 'close' event even if child processes
    // hold the pipe FDs open.
    try {
      electronProcess.stdout?.destroy();
    } catch { /* ignore */ }
    try {
      electronProcess.stderr?.destroy();
    } catch { /* ignore */ }

    // Kill the Electron process group
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch { /* ignore */ }
    }

    await closed;
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await use(window);
  },
});

export { expect } from "@playwright/test";

/**
 * Import the seeded project, dismiss the setup wizard, create a workspace,
 * open a terminal tab, and return once the first workspace-pane is ready.
 * Shared across e2e tests that need a warm workspace+terminal to exercise UI.
 */
export async function bootWorkspaceWithTerminal(
  app: ElectronApplication,
  window: Page,
  tempHome: string,
  workspaceName: string,
): Promise<void> {
  const seededProjectPath = path.join(tempHome, "test-project");

  await app.evaluate(
    ({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [projectPath],
      });
    },
    seededProjectPath,
  );

  await window.locator('[data-testid="import-project-button"]').click();

  const wizard = window.locator('[data-testid="project-setup-wizard"]');
  const skipButton = wizard.getByRole("button", { name: "Skip", exact: true });
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 5; i++) {
    if (!(await wizard.isVisible())) break;
    await skipButton.click();
  }
  await expect(wizard).not.toBeVisible({ timeout: 5_000 });

  await window.locator('[data-testid="sidebar-new-workspace-button"]').click();
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window
    .locator('[data-testid="new-workspace-name-input"]')
    .fill(workspaceName);
  await window.locator('[data-testid="new-workspace-submit"]').click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  await window.keyboard.press("Meta+t");
  await expect(window.locator('[data-testid="terminal-pane"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await assertVisiblePaneCount(window, 1);
}

/** Poll the count of visible workspace-panes (only the active tab's tree counts). */
export async function assertVisiblePaneCount(
  window: Page,
  count: number,
  timeout = 10_000,
): Promise<void> {
  await expect
    .poll(
      () => window.locator('[data-testid="workspace-pane"]:visible').count(),
      { timeout },
    )
    .toBe(count);
}
