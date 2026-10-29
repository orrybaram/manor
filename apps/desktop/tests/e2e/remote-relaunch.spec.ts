import type { ElectronApplication } from "@playwright/test";

import { expect, killApp, launchApp, test } from "./fixtures";
import { stripAnsi } from "./helpers/ansi";
import {
  installRemoteStubs,
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  STEP,
  hostStatus,
  openRemoteProject,
} from "./helpers/remote-project";
import { paneText, runInTerminal } from "./helpers/terminal";
import { waitForAppDocument } from "./helpers/window";

/**
 * Quitting the app with a remote pane still running, then opening it again:
 * the pane shows the session it left, still running, not an empty terminal.
 *
 * Skipped unless MANOR_E2E_SSH=1 (`node scripts/test-remote-e2e.mjs`).
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.beforeEach(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

/** Cmd+Q: the app's own shutdown runs, unlike `killApp`'s SIGKILL. */
async function quitApp(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    app.process().once("exit", () => resolve());
  });
  await app.evaluate(({ app }) => app.quit());
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  await killApp(app);
}

test("a remote pane still running comes back after a quit", async ({
  request,
  tempHome,
}) => {
  test.setTimeout(CONNECT_TIMEOUT + 6 * STEP);

  const first = await launchApp(tempHome);
  let hostId: string;
  let paneId: string;
  try {
    const window = await first.firstWindow();
    await waitForAppDocument(window);
    ({ hostId, paneId } = await openRemoteProject(window, request, tempHome));
    // Output that keeps coming while the app is gone, as an agent's would.
    await runInTerminal(
      window,
      "echo BEFORE_$((40+2)); i=0; while true; do i=$((i+1)); echo TICK_$i; sleep 1; done",
    );
    await expect
      .poll(async () => stripAnsi(await paneText(window, paneId)), { timeout: STEP })
      .toContain("TICK_2");
  } finally {
    await quitApp(first);
  }

  const second = await launchApp(tempHome);
  try {
    const window = await second.firstWindow();
    await waitForAppDocument(window);
    await pollFor(
      "the host connected",
      async () =>
        (await hostStatus(window, hostId))?.status === "connected" ? true : null,
      CONNECT_TIMEOUT,
      500,
    );
    const pane = window.locator(
      `[data-testid="workspace-pane"][data-pane-id="${paneId}"] [data-testid="terminal-pane"]`,
    );
    await expect(pane).toBeVisible({ timeout: STEP });
    // What it printed before the quit, and what it printed since.
    await expect
      .poll(async () => stripAnsi(await paneText(window, paneId)), { timeout: STEP })
      .toContain("BEFORE_42");
    const seen = stripAnsi(await paneText(window, paneId));
    const last = Math.max(...[...seen.matchAll(/TICK_(\d+)/g)].map((m) => Number(m[1])));
    await expect
      .poll(async () => stripAnsi(await paneText(window, paneId)), { timeout: 15_000 })
      .toContain(`TICK_${last + 3}`);
    await window.screenshot({ path: test.info().outputPath("relaunched.png") });
  } finally {
    await killApp(second);
  }
});
