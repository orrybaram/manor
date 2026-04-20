import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  _electron,
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
