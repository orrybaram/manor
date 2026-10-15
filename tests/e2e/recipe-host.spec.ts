import { expect, test } from "./fixtures";
import { addRecipeHost, upCount, writeSshRecipe } from "./helpers/recipe-host";
import {
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  installRemoteStubs,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  STEP,
  hostStatus,
  openRemoteProject,
} from "./helpers/remote-project";
import { readSession } from "./helpers/local-api";
import { runInTerminal } from "./helpers/terminal";

/**
 * A host Manor starts from a recipe, over the remote-host suite's sshd
 * (ADR-231 D6): register it, work on it, stop it, wake it. The helper is
 * `./helpers/recipe-host.ts`; tickets building on it (restore-asleep, idle
 * stop) live in their own specs.
 *
 * Skipped unless MANOR_E2E_SSH=1. Run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only -- tests/e2e/recipe-host.spec.ts
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.beforeEach(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

test.describe("recipe host", () => {
  test.setTimeout(CONNECT_TIMEOUT + 5 * STEP);

  test("starts, works, stops to sleeping and wakes", async ({
    window,
    request,
    tempHome,
  }) => {
    const recipe = { id: "e2e-ssh", name: "E2E recipe box" };
    writeSshRecipe(tempHome, recipe);
    const hostId = await addRecipeHost(window, recipe.id);
    const { paneId } = await openRemoteProject(window, request, tempHome, {
      host: { hostId, hostLabel: recipe.name },
    });

    await runInTerminal(window, "echo RECIPE_$((40+2))");
    await pollFor(
      "the command's output",
      async () =>
        (await readSession(request, tempHome, paneId)).includes("RECIPE_42")
          ? true
          : null,
      STEP,
    );
    expect(upCount(tempHome, recipe.id)).toBe(1);

    await window.evaluate((id) => window.electronAPI.hosts.stop(id), hostId);
    await pollFor(
      "the host sleeping",
      async () =>
        (await hostStatus(window, hostId))?.status === "sleeping" ? true : null,
      STEP,
    );

    await window.evaluate((id) => window.electronAPI.hosts.wake(id), hostId);
    await pollFor(
      "the host connected",
      async () =>
        (await hostStatus(window, hostId))?.status === "connected"
          ? true
          : null,
      CONNECT_TIMEOUT,
    );
    expect(upCount(tempHome, recipe.id)).toBe(2);
  });
});
