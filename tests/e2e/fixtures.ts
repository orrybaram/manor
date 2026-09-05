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

    await removeTempHome(tempHome);
  },

  app: async ({ tempHome }, use) => {
    const app = await launchApp(tempHome);
    // MANOR_E2E_LOG=1 forwards the app's own stdout/stderr into the test
    // output. The launched app is a separate process, so without this its
    // console — including anything the main process logs about a failing
    // request — is invisible to a failing test.
    if (process.env.MANOR_E2E_LOG === "1") {
      const forward = (prefix: string) => (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) console.log(`${prefix} ${line}`);
        }
      };
      app.process().stdout?.on("data", forward("[app out]"));
      app.process().stderr?.on("data", forward("[app err]"));
    }
    await use(app);
    await killApp(app);
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await use(window);
  },
});

export { expect } from "@playwright/test";

/**
 * Remove the temp home, allowing for the app still letting go of it.
 *
 * The daemon and its sessions are killed with the app, but a last scrollback
 * or layout write can land between the kill and this call, and `rm -rf` on a
 * directory that grows a file mid-walk fails with ENOTEMPTY. Retrying is
 * enough; a temp directory that survives anyway is not worth failing a passing
 * test over, so the last attempt only warns.
 */
async function removeTempHome(tempHome: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[e2e] could not remove ${tempHome}:`, err);
  }
}

/**
 * Launch the built app against `tempHome`.
 *
 * The environment is inherited minus anything that would point the app at a
 * different build: VITE_DEV_SERVER_URL is set in any shell started by
 * `pnpm dev`, and the app prefers it over the bundled renderer — so a run from
 * such a shell silently tests the dev server, or loads a blank error page once
 * that server exits.
 */
export async function launchApp(
  tempHome: string,
): Promise<ElectronApplication> {
  const { VITE_DEV_SERVER_URL: _devServer, ...rest } = process.env;

  // A run started from a terminal *inside* Manor inherits that app's session
  // environment — MANOR_PANE_ID, MANOR_HOOK_PORT, and a ZDOTDIR pointing at
  // the real installation's shell config. Left in place, the test app's shells
  // source another Manor's zdotdir out of a home that no longer exists, and
  // anything reading MANOR_* before the pty layer overrides it talks to the
  // wrong app. Drop the lot: the launched app is meant to know nothing but
  // `tempHome`.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (key.startsWith("MANOR_") || key === "ZDOTDIR") continue;
    env[key] = value;
  }
  env.PATH = pathWithoutAgents(env.PATH ?? "");

  return _electron.launch({
    args: [
      path.join(repoRoot, "dist-electron/main.js"),
      // Electron's userData — localStorage, IndexedDB, session storage —
      // defaults to ~/Library/Application Support/Electron regardless of HOME.
      // Left there, a run would see what the previous one persisted in the
      // renderer, and the real installation's storage sits one directory over.
      `--user-data-dir=${path.join(tempHome, "user-data")}`,
    ],
    env: { ...env, HOME: tempHome },
    cwd: repoRoot,
    recordVideo: videoDir() ? { dir: videoDir()!, size: VIDEO_SIZE } : undefined,
  });
}

/** Frame size for recorded videos; kept fixed so runs are comparable. */
const VIDEO_SIZE = { width: 1280, height: 800 };

/**
 * Where to record a video of every window, or `undefined` to not record.
 *
 * Set `MANOR_E2E_VIDEO=1` to record into `tests/e2e/artifacts/video/`, or to a
 * path to record there instead. Recording is off by default: it costs a
 * screencast per window for the whole run, and only matters when a run needs
 * to be reviewed afterwards.
 */
export function videoDir(): string | undefined {
  const raw = process.env.MANOR_E2E_VIDEO;
  if (!raw) return undefined;
  return raw === "1"
    ? path.join(__dirname, "artifacts", "video")
    : path.resolve(raw);
}

/**
 * PATH with any directory holding a real agent CLI removed.
 *
 * Manor's default agent command is `claude`, and a test that has not yet
 * pointed its project somewhere else — or that consumes a session warmed
 * before it did — would otherwise launch the real thing: a live agent, in a
 * temp home, waiting on onboarding no one is watching. A test run must not be
 * able to start one by accident, so the binaries are simply not reachable.
 */
function pathWithoutAgents(currentPath: string): string {
  const agents = ["claude", "codex"];
  return currentPath
    .split(path.delimiter)
    .filter(
      (dir) =>
        dir !== "" &&
        !agents.some((agent) => {
          try {
            fs.accessSync(path.join(dir, agent), fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        }),
    )
    .join(path.delimiter);
}

/**
 * Shut the app down.
 *
 * app.close() hangs because Manor's detached child processes (terminal-host,
 * spawned with stdio:["ignore","ignore","inherit"]) keep the Electron stderr
 * pipe open, and Playwright waits for the 'close' event (all stdio closed).
 * So: destroy the piped stdio directly, then kill the process group.
 */
export async function killApp(app: ElectronApplication): Promise<void> {
  // A recording is only written out when its context closes. SIGKILL skips
  // that, so when recording, give the context a moment to flush first. The
  // race is because context.close() can hang for the same reason app.close()
  // does; the kill below is what actually ends the process either way.
  if (videoDir()) {
    await Promise.race([
      app.context().close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  const electronProcess = app.process();
  const pid = electronProcess.pid;

  const closed = new Promise<void>((resolve) => {
    if (
      electronProcess.exitCode !== null ||
      electronProcess.signalCode !== null
    ) {
      // Already exited — resolve after the current tick so Playwright's own
      // 'close' listener (registered before ours) has had a chance to run.
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
}

/**
 * Import the seeded project and dismiss the setup wizard.
 *
 * Split out from `bootWorkspaceWithTerminal` because *when* a project exists
 * matters to anything that configures it: a test that wants a different agent
 * command has to set it before a workspace — and therefore a prewarmed
 * session — is created against the old one.
 */
export async function importSeededProject(
  app: ElectronApplication,
  window: Page,
  tempHome: string,
): Promise<void> {
  const seededProjectPath = path.join(tempHome, "test-project");

  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, seededProjectPath);

  await window.locator('[data-testid="import-project-button"]').click();

  const wizard = window.locator('[data-testid="project-setup-wizard"]');
  const skipButton = wizard.getByRole("button", { name: "Skip", exact: true });
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 5; i++) {
    if (!(await wizard.isVisible())) break;
    await skipButton.click();
  }
  await expect(wizard).not.toBeVisible({ timeout: 5_000 });
}

/** Open a terminal tab and wait for its pane to be the only visible one. */
export async function openTerminalTab(window: Page): Promise<void> {
  await window.keyboard.press("Meta+t");
  await expect(
    window.locator('[data-testid="terminal-pane"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await assertVisiblePaneCount(window, 1);
}

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
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, workspaceName);
  await openTerminalTab(window);
}

/**
 * Open the New Workspace dialog and create `name` in the selected project.
 *
 * Driven by the new-workspace keybinding (Meta+Shift+N) rather than a sidebar
 * button — the button's test id drifted away once already, and the keybinding
 * is a stable, user-facing entry point.
 */
export async function createWorkspace(
  window: Page,
  name: string,
): Promise<void> {
  await window.keyboard.press("Meta+Shift+n");
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window.locator('[data-testid="new-workspace-name-input"]').fill(name);
  await window.locator('[data-testid="new-workspace-submit"]').click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
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
