import fs from "fs";
import path from "path";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { test as base, expect } from "./fixtures";

const repoRoot = path.join(__dirname, "../..");

/**
 * Overrides the base `app` fixture to seed a projects.json before launch.
 * The seeded project has `worktreeStartScript: "sleep 4"` and
 * `setupComplete: true` so the app boots straight into a state where a new
 * workspace can be created and its setup script runs long enough for us to
 * navigate away mid-flight.
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

    const app = await _electron.launch({
      args: [path.join(repoRoot, "dist-electron/main.js")],
      env: { ...process.env, HOME: tempHome },
      cwd: repoRoot,
    });

    await use(app);

    // Same shutdown dance as the base fixture — terminal-host child keeps the
    // stderr pipe open so app.close() hangs. Force stdio close + SIGKILL the
    // process group.
    const electronProcess = app.process();
    const pid = electronProcess.pid;
    const closed = new Promise<void>((resolve) => {
      if (
        electronProcess.exitCode !== null ||
        electronProcess.signalCode !== null
      ) {
        setImmediate(resolve);
      } else {
        electronProcess.once("close", () => setImmediate(resolve));
      }
    });
    try {
      electronProcess.stdout?.destroy();
    } catch {
      /* ignore */
    }
    try {
      electronProcess.stderr?.destroy();
    } catch {
      /* ignore */
    }
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await closed;
  },
});

test("setup script survives navigation; persistent toast signals background work", async ({
  window,
  tempHome,
}) => {
  // Resolve symlinks — on macOS $TMPDIR (/var/folders/…) is a symlink to
  // /private/var/folders/…, and `git worktree list` reports the resolved
  // path. The sidebar's data-workspace-path attribute comes from git, so we
  // must match the resolved form.
  const projectPath = fs.realpathSync(path.join(tempHome, "test-project"));

  // Project is pre-seeded, so no wizard and no import step. Sidebar should
  // already show the project with its main workspace.
  await expect(
    window.locator(`[data-testid="workspace-item"][data-workspace-path="${projectPath}"]`),
  ).toBeVisible({ timeout: 10_000 });

  // Create a new workspace named "smoke-bg".
  await window.locator('[data-testid="sidebar-new-workspace-button"]').click();
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window.locator('[data-testid="new-workspace-name-input"]').fill("smoke-bg");
  await window.locator('[data-testid="new-workspace-submit"]').click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  // Setup view should appear — git ops are fast, then the setup-script step
  // flips to in-progress and the PTY runs `sleep 4` in the background.
  const setupView = window.locator('[data-testid="workspace-setup-view"]');
  await expect(setupView).toBeVisible({ timeout: 10_000 });

  // Wait until the setup-script step is the active one (checklist shows
  // "Running setup script") — this confirms the git phase finished and the
  // long-running script is mid-flight.
  await expect(setupView.getByText("Running setup script")).toBeVisible({
    timeout: 10_000,
  });

  // Navigate away by clicking the project's main workspace in the sidebar.
  // The main workspace's row has data-workspace-path === projectPath.
  await window
    .locator(
      `[data-testid="workspace-item"][data-workspace-path="${projectPath}"]`,
    )
    .click();

  // Setup view should unmount for the backgrounded workspace.
  await expect(setupView).not.toBeVisible({ timeout: 5_000 });

  // Persistent "Setting up …" toast appears because the unmount hook fires
  // with setup still running. Toast message includes the workspace name.
  await expect(window.getByText(/Setting up "smoke-bg"/)).toBeVisible({
    timeout: 5_000,
  });

  // Wait for the PTY to exit (sleep 4 is ~4s; give generous headroom). The
  // orchestrator's exit handler removes the background toast and fires the
  // existing success toast.
  await expect(window.getByText("Workspace setup complete")).toBeVisible({
    timeout: 15_000,
  });
  await expect(window.getByText(/Setting up "smoke-bg"/)).not.toBeVisible({
    timeout: 5_000,
  });
});
