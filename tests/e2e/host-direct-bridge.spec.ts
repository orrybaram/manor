import { spawnSync } from "child_process";

import { expect, test } from "./fixtures";
import { readSession, readSessionMeta } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import {
  installRemoteStubs,
  onRemote,
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  stopHostServer,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  STEP,
  hostStatus,
  openRemoteProject,
} from "./helpers/remote-project";
import { paneText, runInTerminal } from "./helpers/terminal";

/**
 * A desktop window talks to a remote host's server itself:
 * its own `manor-host server-bridge --viewer` stream to the box, which carries
 * the window's calls for that host, its terminals included.
 *
 * - A pane on the box is typed into and resized over that stream.
 * - The stream dies: the window goes on through main and dials the
 *   stream again, and the pane is typed into once it is back.
 * - An older host server (it does not report `viewer-bridge`) gets no
 *   stream, and its pane works through main.
 * - A phone paired only with the desktop types into a pane on the box, and
 *   sees its output: main forwards the pane's terminal to the box's server
 *   over a local relay (`relayTest`).
 *
 * Each test starts from a clean box, so each one's project is the box's only
 * one. Skipped unless MANOR_E2E_SSH=1; run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.describe.configure({ mode: "serial" });

/**
 * Make the box's host server, from its next start, report no capabilities:
 * an older server (`reportedCapabilities`). The harness's
 * ForceCommand sources `~/.manor-e2e/env` into every session, the one that
 * starts the server included; `resetRemoteBox` deletes it.
 */
function pretendOldHostServer(): void {
  onRemote(
    'mkdir -p "$HOME/.manor-e2e" && echo "export MANOR_E2E_HOST_CAPABILITIES=" > "$HOME/.manor-e2e/env"',
  );
}

test.beforeEach(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

test.afterAll(() => {
  // The next suite's host server must say what this build says.
  stopHostServer();
  onRemote('rm -f "$HOME/.manor-e2e/env"; true');
});

/**
 * The window's viewer streams to the box: the `ssh … server-bridge --viewer`
 * children main spawns for it (and, on the private-sshd target, the server
 * side of each, on this same machine).
 */
function viewerStreams(): number {
  const out = spawnSync("pgrep", ["-f", "server-bridge --viewer"], { encoding: "utf-8" });
  return out.stdout.split("\n").filter(Boolean).length;
}

function killViewerStreams(): void {
  spawnSync("pkill", ["-f", "server-bridge --viewer"]);
}

/**
 * Type `marker`'s command and wait for the box's shell to have run it, and
 * for its output to be back on the window's screen.
 */
async function typeAndSee(
  window: Parameters<typeof runInTerminal>[0],
  request: Parameters<typeof readSession>[0],
  tempHome: string,
  paneId: string,
  marker: string,
): Promise<void> {
  // The shell computes the marker, so the typed text never matches it.
  await runInTerminal(window, `echo ${marker}_$((20+22))`);
  const expected = `${marker}_42`;
  await expect
    .poll(() => readSession(request, tempHome, paneId), { timeout: STEP })
    .toContain(expected);
  await expect.poll(() => paneText(window, paneId), { timeout: STEP }).toContain(expected);
}

test.describe("a desktop window's own bridge to the host server", () => {
  test.setTimeout(CONNECT_TIMEOUT + 4 * STEP);

  test("a remote pane types and resizes over the window's own stream", async ({
    app,
    window,
    request,
    tempHome,
  }) => {
    const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
    expect(await hostStatus(window, hostId)).toMatchObject({ viewerBridge: true });
    await pollFor("the window's viewer stream", () => (viewerStreams() > 0 ? true : null), STEP);

    await typeAndSee(window, request, tempHome, paneId, "DIRECT");

    // The window is the only viewer of its pane, so it owns the grid and a
    // resize reaches the box's pty.
    const before = await readSessionMeta(request, tempHome, paneId);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width - 200, height - 160);
    });
    await expect
      .poll(async () => (await readSessionMeta(request, tempHome, paneId)).cols, {
        timeout: STEP,
      })
      .toBeLessThan(before.cols ?? Number.POSITIVE_INFINITY);
  });

  test("killing the viewer stream falls back to main, and the stream comes back", async ({
    window,
    request,
    tempHome,
  }) => {
    const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
    await pollFor("the window's viewer stream", () => (viewerStreams() > 0 ? true : null), STEP);

    killViewerStreams();
    // The host itself is still connected: main answers for it meanwhile, and
    // typing is never dropped as if it were away.
    expect((await hostStatus(window, hostId))?.status).toBe("connected");
    await expect(window.getByTestId("host-offline-banner")).not.toBeVisible();
    // Main forwards the pane's terminal to the box's server meanwhile, its
    // output included, so what was typed is on the screen too.
    await typeAndSee(window, request, tempHome, paneId, "FALLBACK");

    // The window dials its stream again, and its pane reattaches over it:
    // what it missed is on its screen too.
    await pollFor("the viewer stream back", () => (viewerStreams() > 0 ? true : null), STEP);
    await typeAndSee(window, request, tempHome, paneId, "RECOVERED");
    await expect.poll(() => paneText(window, paneId), { timeout: STEP }).toContain("FALLBACK_42");
  });

  test("a host server without viewer-bridge works through main", async ({
    window,
    request,
    tempHome,
  }) => {
    // The box's host server starts reporting no capabilities: an older one.
    stopHostServer();
    pretendOldHostServer();

    const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
    await pollFor(
      "the host's first status",
      async () => ((await hostStatus(window, hostId))?.viewerBridge === false ? true : null),
      STEP,
    );
    await typeAndSee(window, request, tempHome, paneId, "THROUGH_MAIN");
    expect(viewerStreams()).toBe(0);
  });
});

relayTest.describe("a phone paired only with the desktop", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 4 * STEP);

  relayTest("types into a pane on the box, through the desktop", async ({
    window,
    request,
    tempHome,
  }) => {
    const { paneId } = await openRemoteProject(window, request, tempHome);
    const device = await pairBrowser(window, { label: "desktop-only phone" });
    await closeSettings(window);

    const client = await openWebApp(device.link);
    try {
      const page = client.page;
      const pane = page
        .locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"] [data-testid="terminal-pane"]`)
        .first();
      await expect(pane).toBeVisible({ timeout: 30_000 });
      await pane.click();
      // The shell computes the marker, so the typed text never matches it.
      await page.keyboard.type("echo PHONE_$((20+22))");
      await page.keyboard.press("Enter");
      // The box ran it, and its output came back to the phone through main.
      await expect
        .poll(() => readSession(request, tempHome, paneId), { timeout: STEP })
        .toContain("PHONE_42");
      await expect.poll(() => paneText(page, paneId), { timeout: STEP }).toContain("PHONE_42");
    } catch (err) {
      console.log(`[host-direct-bridge.spec] phone log:\n${client.log.join("\n")}`);
      throw err;
    } finally {
      await client.close();
    }
  });
});
