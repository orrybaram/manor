import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  expect,
  killApp,
  launchApp,
  openTerminalTab,
  test,
} from "./fixtures";
import { addRecipeHost, upCount, writeSshRecipe } from "./helpers/recipe-host";
import {
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  installRemoteStubs,
  onRemote,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  PROJECT_NAME,
  STEP,
  hostStatus,
  openRemoteProject,
} from "./helpers/remote-project";
import { readSession } from "./helpers/local-api";
import { activePaneId, runInTerminal } from "./helpers/terminal";
import { waitForAppDocument } from "./helpers/window";

/**
 * Restoring a window doesn't wake a sleeping host.
 *
 * A host that was asleep when the app quit stays asleep when it comes back:
 * the restored panes are created with `wake: false` and wait behind the
 * asleep banner. Waking it is the person's choice: the banner's "wake it", or
 * opening a workspace of that host that was not restored.
 *
 * Launches its own app instances rather than taking the fixture's, as
 * `viewport.spec.ts` does. The recipe host is `./helpers/recipe-host.ts`.
 *
 * Skipped unless MANOR_E2E_SSH=1. Run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only -- tests/e2e/host-restore-asleep.spec.ts
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.beforeEach(() => {
  resetRemoteBox();
  // A workspace made on the box outlives the clone that owns it, and the next
  // run's `git worktree add` finds its folder taken.
  onRemote('rm -rf "$HOME/.manor/worktrees"');
  installRemoteStubs();
  seedRemoteRepo();
});

const RECIPE = { id: "e2e-restore", name: "E2E restore box" };

async function waitForHost(
  window: Page,
  hostId: string,
  status: string,
  timeout: number,
): Promise<void> {
  await pollFor(
    `the host ${status}`,
    async () => {
      const host = await hostStatus(window, hostId);
      if (host?.status === "error")
        throw new Error(`host failed: ${host.error}`);
      return host?.status === status ? true : null;
    },
    timeout,
    500,
  );
}

/**
 * The window's viewport is written on a debounce, and `killApp` is a SIGKILL
 * that skips the final save. The layout is the host server's, on the box (not
 * the desktop's `layout.json`), and it is saved as the pane is made.
 */
async function waitForSavedViewport(tempHome: string): Promise<void> {
  await expect
    .poll(
      () => {
        const file = path.join(tempHome, ".manor", "viewport.json");
        return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      },
      { timeout: 15_000 },
    )
    .toContain(PROJECT_NAME);
}

/**
 * `createWorkspace` from the fixtures, with a longer wait: the worktree is
 * made on the box over ssh.
 */
async function createRemoteWorkspace(
  window: Page,
  name: string,
): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+n");
  const dialog = window.getByTestId("new-workspace-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window.getByTestId("new-workspace-name-input").fill(name);
  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog).not.toBeVisible({ timeout: STEP });
}

/** Stop the host, wait for it to sleep, and kill the app. */
async function sleepAndKill(
  app: ElectronApplication,
  window: Page,
  hostId: string,
): Promise<void> {
  await window.evaluate((id) => window.electronAPI.hosts.stop(id), hostId);
  await waitForHost(window, hostId, "sleeping", STEP);
  await killApp(app);
}

/** The relaunch, held at `sleeping` for ten seconds with `up` never run again. */
async function expectStillAsleep(
  window: Page,
  tempHome: string,
  hostId: string,
): Promise<void> {
  await expect(window.getByTestId("host-offline-banner").first()).toBeVisible({
    timeout: 30_000,
  });
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    expect((await hostStatus(window, hostId))?.status).toBe("sleeping");
    expect(upCount(tempHome, RECIPE.id)).toBe(1);
    await window.waitForTimeout(500);
  }
  await expect(window.getByTestId("host-asleep-label").first()).toBeVisible();
}

test.describe("restore with a sleeping host", () => {
  test.setTimeout(2 * CONNECT_TIMEOUT + 6 * STEP);

  test("shows the asleep banner, and wake it reattaches the pane", async ({
    tempHome,
    request,
  }) => {
    writeSshRecipe(tempHome, RECIPE);

    const first = await launchApp(tempHome);
    let hostId: string;
    let paneId: string;
    try {
      const window = await first.firstWindow();
      await waitForAppDocument(window);
      hostId = await addRecipeHost(window, RECIPE.id);
      ({ paneId } = await openRemoteProject(window, request, tempHome, {
        host: { hostId, hostLabel: RECIPE.name },
      }));
      expect(upCount(tempHome, RECIPE.id)).toBe(1);
      await waitForSavedViewport(tempHome);
      await sleepAndKill(first, window, hostId);
    } finally {
      await killApp(first);
    }

    const second = await launchApp(tempHome);
    try {
      const window = await second.firstWindow();
      await waitForAppDocument(window);

      await expectStillAsleep(window, tempHome, hostId);

      await window
        .getByTestId("host-offline-banner")
        .first()
        .getByRole("button", { name: "wake it" })
        .click();
      await waitForHost(window, hostId, "connected", CONNECT_TIMEOUT);
      expect(upCount(tempHome, RECIPE.id)).toBe(2);

      await expect(window.getByTestId("host-offline-banner")).toHaveCount(0, {
        timeout: STEP,
      });
      await runInTerminal(window, "echo RESTORED_$((40+2))");
      await pollFor(
        "the command's output on the box",
        async () =>
          (await readSession(request, tempHome, paneId)).includes("RESTORED_42")
            ? true
            : null,
        STEP,
      );
    } finally {
      await killApp(second);
    }
  });

  test("opening another workspace of the host wakes it", async ({
    tempHome,
    request,
  }) => {
    writeSshRecipe(tempHome, RECIPE);
    const otherName = "second-workspace";

    const first = await launchApp(tempHome);
    let hostId: string;
    let paneId: string;
    try {
      const window = await first.firstWindow();
      await waitForAppDocument(window);
      hostId = await addRecipeHost(window, RECIPE.id);
      ({ paneId } = await openRemoteProject(window, request, tempHome, {
        host: { hostId, hostLabel: RECIPE.name },
      }));

      // A second workspace with a pane of its own, then back to the first,
      // so the first is the one that is visible when the app dies.
      await createRemoteWorkspace(window, otherName);
      await openTerminalTab(window);
      await expect(window.getByTestId("workspace-item")).toHaveCount(2, {
        timeout: STEP,
      });
      await window
        .getByTestId("workspace-item")
        .filter({ hasNotText: otherName })
        .first()
        .click();
      await expect
        .poll(() => activePaneId(window), { timeout: STEP })
        .toBe(paneId);

      await waitForSavedViewport(tempHome);
      await sleepAndKill(first, window, hostId);
    } finally {
      await killApp(first);
    }

    const second = await launchApp(tempHome);
    try {
      const window = await second.firstWindow();
      await waitForAppDocument(window);

      await expectStillAsleep(window, tempHome, hostId);

      await window
        .getByTestId("workspace-item")
        .filter({ hasText: otherName })
        .first()
        .click();
      await waitForHost(window, hostId, "connected", CONNECT_TIMEOUT);
      expect(upCount(tempHome, RECIPE.id)).toBe(2);
    } finally {
      await killApp(second);
    }
  });
});
