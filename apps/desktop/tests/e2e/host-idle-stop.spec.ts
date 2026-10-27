import fs from "fs";
import path from "path";
import { createWorkspace, expect, killApp, launchApp } from "./fixtures";
import { stripAnsi } from "./helpers/ansi";
import { openWebApp } from "./helpers/phone";
import {
  addRecipeHost,
  stopCount,
  upCount,
  writeSshRecipe,
} from "./helpers/recipe-host";
import { relayTest } from "./helpers/relay-fixture";
import {
  installRemoteStubs,
  onRemote,
  pointHostServerAtRelay,
  pollFor,
  remoteKind,
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
import { closeSettings, pairHostPhone } from "./helpers/settings";
import { paneText, runInTerminal } from "./helpers/terminal";
import { waitForAppDocument } from "./helpers/window";

/**
 * A phone watching a pane keeps its host awake.
 *
 * The recipe says `idleStopMinutes: 1`. A phone paired with the host holds one
 * of its panes open while the desktop looks at something else, so the host
 * server reports `viewing: {device: true, desktop: false}`. The idle check
 * runs every minute (`IDLE_STOP_RECHECK_MS`) with no test override, so the
 * host must stay `connected`, and `stop` must not run, for two and a half
 * minutes. Once the phone closes, the host stops itself and reads `sleeping`.
 * The desktop that does not view the pane is a relaunch restored onto a local
 * workspace: a window that only hides a workspace keeps its panes mounted, and
 * a reload leaves a forwarded subscription behind. No agent runs on the box, as one would make it busy on its own account.
 *
 * Slow on purpose, about four minutes. To leave it out of a quick run:
 *
 *   node scripts/test-remote-e2e.mjs -- --grep-invert "idle stop"
 *
 * Needs the private-sshd target: the box must reach the test's local relay on
 * 127.0.0.1, which a Docker container cannot. Skipped unless MANOR_E2E_SSH=1.
 */

const skipReason =
  remoteSkipReason() ??
  (remoteKind() === "docker"
    ? "the container cannot reach the local relay on the test machine's loopback"
    : null);
relayTest.skip(skipReason !== null, skipReason ?? "");

relayTest.beforeEach(() => {
  resetRemoteBox();
  // A workspace made on the box outlives the clone that owns it.
  onRemote('rm -rf "$HOME/.manor/worktrees"');
  installRemoteStubs();
  seedRemoteRepo();
});

const RECIPE = { id: "e2e-idle", name: "E2E idle box", idleStopMinutes: 1 };
const LOCAL_PROJECT = "local-elsewhere";
/** Past two idle checks (`IDLE_STOP_RECHECK_MS` is a minute), plus margin. */
const HOLD_MS = 150_000;
const SLEEP_WITHIN_MS = 90_000;

relayTest.describe("idle stop", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 10 * STEP);

  relayTest(
    "a phone watching a pane keeps the host up; closing it lets the host stop",
    async ({ request, tempHome, relay, appLaunch }) => {
      pointHostServerAtRelay(relay.url);
      writeSshRecipe(tempHome, RECIPE);

      // The first launch sets the scene, then dies: a window that merely
      // hides a workspace still has its panes mounted, so the desktop that
      // does not view the pane is one restored onto a local workspace.
      const first = await launchApp(tempHome, appLaunch);
      let hostId: string;
      let paneId: string;
      let link: string;
      try {
        const window = await first.firstWindow();
        await waitForAppDocument(window);
        hostId = await addRecipeHost(window, RECIPE.id);
        ({ paneId } = await openRemoteProject(window, request, tempHome, {
          host: { hostId, hostLabel: RECIPE.name },
        }));
        expect(upCount(tempHome, RECIPE.id)).toBe(1);
        await runInTerminal(window, "echo PHONE_SEES_$((40+2))");

        ({ link } = await pairHostPhone(window, {
          hostName: RECIPE.name,
          label: "idle phone",
        }));
        await closeSettings(window);

        // The sidebar reads projects once, so a reload shows the new one.
        await window.evaluate(
          ([name, dir]) => window.electronAPI.projects.add(name, dir),
          [LOCAL_PROJECT, path.join(tempHome, "test-project")] as const,
        );
        await window.reload();
        await window.waitForLoadState("domcontentloaded");
        await window.getByText(LOCAL_PROJECT, { exact: true }).first().click();
        await createWorkspace(window, "elsewhere");
        await expect
          .poll(
            () => {
              const file = path.join(tempHome, ".manor", "viewport.json");
              return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
            },
            { timeout: 15_000 },
          )
          .toContain(LOCAL_PROJECT);
      } finally {
        await killApp(first);
      }

      const client = await openWebApp(link);
      const second = await launchApp(tempHome, appLaunch);
      try {
        const page = client.page;
        const pane = page
          .locator(
            `[data-testid="workspace-pane"][data-pane-id="${paneId}"] [data-testid="terminal-pane"]`,
          )
          .first();
        await expect(pane).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(async () => stripAnsi(await paneText(page, paneId)), {
            timeout: STEP,
          })
          .toContain("PHONE_SEES_42");

        const window = await second.firstWindow();
        await waitForAppDocument(window);
        await pollFor(
          "the host connected",
          async () =>
            (await hostStatus(window, hostId))?.status === "connected"
              ? true
              : null,
          CONNECT_TIMEOUT,
          500,
        );
        const viewing = async () =>
          (
            await window.evaluate(
              (id) => window.electronAPI.hosts.serverStatus(id),
              hostId,
            )
          ).status?.viewing;
        await pollFor(
          "only the phone viewing",
          async () => {
            const v = await viewing();
            return v?.device === true && !v.desktop && !v.forwarded ? v : null;
          },
          STEP,
          500,
        );

        // Two idle checks fall in this window; neither may stop the host.
        const until = Date.now() + HOLD_MS;
        while (Date.now() < until) {
          expect((await hostStatus(window, hostId))?.status).toBe("connected");
          expect(stopCount(tempHome, RECIPE.id)).toBe(0);
          await window.waitForTimeout(2_000);
        }
        expect((await viewing())?.device).toBe(true);

        await client.close();
        const closedAt = Date.now();
        await pollFor(
          "the idle host sleeping",
          async () =>
            (await hostStatus(window, hostId))?.status === "sleeping"
              ? true
              : null,
          SLEEP_WITHIN_MS,
          1_000,
        );
        console.log(
          `[host-idle-stop] slept ${Math.round((Date.now() - closedAt) / 1000)}s after the phone closed`,
        );
        expect(stopCount(tempHome, RECIPE.id)).toBe(1);
      } finally {
        await client.close().catch(() => {});
        await killApp(second);
      }
    },
  );
});
