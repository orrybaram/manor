import fs from "fs";
import path from "path";
import { type ElectronApplication, type Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  createWorkspace,
  killApp,
  launchApp,
  test as base,
  expect,
} from "./fixtures";

/**
 * Overrides the base `app` fixture to seed a projects.json before launch.
 * The seeded project has `worktreeStartScript: "sleep 4"` and
 * `setupComplete: true` so the app boots straight into a state where a new
 * workspace can be created and its setup script runs long enough for us to
 * navigate away mid-flight.
 *
 * The script runs on the server, in a tab of its own: no
 * renderer drives it, so it finishes — and its tab closes — whether or not
 * anyone is looking.
 */
const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");

    // Manor resolves manorDataDir() to $HOME/Library/Application Support/Manor
    // on macOS and $HOME/.local/share/Manor on Linux. Seed both so this test
    // runs on either platform.
    const seed = {
      projects: [
        {
          id: "proj-smoke-bg",
          name: "test-project",
          path: projectPath,
          defaultBranch: "main",
          workspaces: [
            {
              path: projectPath,
              branch: "main",
              isMain: true,
              name: null,
              linkedIssues: [],
            },
          ],
          selectedWorkspaceIndex: 0,
          defaultRunCommand: null,
          worktreePath: null,
          worktreeStartScript: "sleep 4",
          worktreeTeardownScript: null,
          linearAssociations: [],
          color: null,
          agentCommand: null,
          commands: [],
          themeName: null,
          setupComplete: true,
        },
      ],
      selectedProjectIndex: 0,
    };

    const dataDirs = [
      path.join(tempHome, "Library", "Application Support", "Manor"),
      path.join(tempHome, ".local", "share", "Manor"),
    ];
    for (const dir of dataDirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "projects.json"),
        JSON.stringify(seed, null, 2),
      );
    }

    const app = await launchApp(tempHome);
    await use(app);
    await killApp(app);
  },
});

test("setup script runs in a tab of its own and finishes with nobody watching", async ({
  window,
  tempHome,
}) => {
  // Resolve symlinks — on macOS $TMPDIR (/var/folders/…) is a symlink to
  // /private/var/folders/…, and `git worktree list` reports the resolved
  // path. The sidebar's data-workspace-path attribute comes from git, so we
  // must match the resolved form.
  const projectPath = fs.realpathSync(path.join(tempHome, "test-project"));
  const mainItem = window.locator(
    `[data-testid="workspace-item"][data-workspace-path="${projectPath}"]`,
  );

  // Project is pre-seeded, so no wizard and no import step. Sidebar should
  // already show the project with its main workspace.
  await expect(mainItem).toBeVisible({ timeout: 10_000 });

  // Create a new workspace named "smoke-bg".
  await createWorkspace(window, "smoke-bg");

  // The server opened the script's tab before the create answered, so the
  // new workspace lands on it — a terminal running `sleep 4; exit` — not on
  // the setup view.
  await assertVisiblePaneCount(window, 1);
  await expect(window.locator('[data-testid="workspace-setup-view"]')).not.toBeVisible();

  // Navigate away by clicking the project's main workspace in the sidebar.
  await mainItem.click();

  // The script still finishes: the server follows it, and so does the toast
  // the create left behind.
  await expect(window.getByText("Workspace setup complete")).toBeVisible({
    timeout: 15_000,
  });

  // Its tab closed with its shell (the server closes it on exit).
  await window
    .locator('[data-testid="workspace-item"]', { hasText: "smoke-bg" })
    .click();
  await assertVisiblePaneCount(window, 0);
});
