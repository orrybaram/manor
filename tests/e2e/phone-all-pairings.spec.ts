import path from "path";

import type { Page } from "@playwright/test";

import { expect, killApp } from "./fixtures";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  APP_TARGET,
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
  PROJECT_NAME,
  STEP,
  openRemoteProject,
} from "./helpers/remote-project";
import { closeSettings, pairBrowser, pairHostPhone } from "./helpers/settings";

/**
 * A phone holds every pairing at once (ADR-228 D8): paired with the desktop
 * and with a remote host's server, it sees both in one sidebar.
 *
 * 1. The desktop clones a project onto the box, and adds one of its own.
 * 2. One browser opens two links: the desktop's, then the box's host
 *    server's. The page dials both rooms; the sidebar lists the desktop's
 *    project and the box's, the box's answered by its own pairing (D3).
 * 3. The desktop stops. The box's project stays live: the phone asks the box
 *    for a branch made on it after the desktop went, and gets it. A write to
 *    the desktop's project is refused as the desktop being away (D6), and
 *    its project is still listed from what it last said.
 * 4. The desktop's pairing is removed in the Hosts sheet: its project leaves
 *    the sidebar, and the box's stays.
 *
 * Needs the private-sshd target (`node scripts/test-remote-e2e.mjs`), as
 * `host-server.spec.ts` does: the box must reach the local relay.
 */

const skipReason =
  remoteSkipReason() ??
  (remoteKind() === "docker"
    ? "the container cannot reach the local relay on the test machine's loopback"
    : null);
relayTest.skip(skipReason !== null, skipReason ?? "");

relayTest.describe.configure({ mode: "serial" });

relayTest.beforeAll(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

const LOCAL_PROJECT = "desk-e2e";
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

/** The room a pairing link dials: `#relay=<roomId>.<key>&t=<token>`. */
function roomOf(link: string): string {
  const relay = new URLSearchParams(new URL(link).hash.slice(1)).get("relay") ?? "";
  return relay.slice(0, relay.indexOf("."));
}

interface PhoneProject {
  id: string;
  name: string;
  hostId: string;
}

function phoneProjects(page: Page): Promise<PhoneProject[]> {
  return page.evaluate(async () =>
    (await window.electronAPI.projects.getAll()).map((p) => ({
      id: p.id,
      name: p.name,
      hostId: p.hostId,
    })),
  );
}

/** A project's name, as the sidebar shows it. */
function sidebarProject(page: Page, name: string) {
  return page.getByText(name, { exact: true });
}

relayTest.describe("a phone with every pairing at once", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 8 * STEP);

  relayTest(
    "sees the desktop's and the host's projects in one sidebar, and keeps the host's with the desktop gone",
    async ({ app, window, request, tempHome, relay }) => {
      pointHostServerAtRelay(relay.url);

      // 1. A project on the box, and one on the desktop.
      await openRemoteProject(window, request, tempHome);
      await window.evaluate(
        ([name, dir]) => window.electronAPI.projects.add(name, dir),
        [LOCAL_PROJECT, path.join(tempHome, "test-project")] as const,
      );

      // 2. Both pairings, in one browser.
      const desk = await pairBrowser(window, { label: "two-pairing phone" });
      const box = await pairHostPhone(window, {
        hostName: APP_TARGET,
        label: "two-pairing phone (box)",
      });
      await closeSettings(window);
      const deskRoom = roomOf(desk.link);
      const boxRoom = roomOf(box.link);
      expect(deskRoom).not.toBe(boxRoom);

      const client = await openWebApp(desk.link, { viewport: DESK });
      try {
        const page = client.page;
        await expect(sidebarProject(page, LOCAL_PROJECT).first()).toBeVisible({ timeout: 30_000 });
        // The box's link, on the same page: a fragment-only change is no
        // load, so load it.
        await page.goto(box.link);
        await page.reload();
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                JSON.parse(localStorage.getItem("manor.web.pairings") ?? "[]").map(
                  (p: { roomId: string }) => p.roomId,
                ),
              ),
            { timeout: 15_000 },
          )
          .toEqual([deskRoom, boxRoom]);

        // One sidebar: the desktop's project and the box's, each named by
        // its room (D2), the box's from its own pairing (D3).
        await expect(sidebarProject(page, LOCAL_PROJECT).first()).toBeVisible({ timeout: 30_000 });
        await expect(sidebarProject(page, PROJECT_NAME).first()).toBeVisible({ timeout: 30_000 });
        const projects = await pollFor(
          "both hosts' projects on the phone",
          async () => {
            const all = await phoneProjects(page);
            const mine = all.find((p) => p.name === LOCAL_PROJECT);
            const boxs = all.find((p) => p.name === PROJECT_NAME);
            return mine?.hostId === deskRoom && boxs?.hostId === boxRoom ? { mine, boxs } : null;
          },
          STEP,
        );

        // 3. The desktop stops.
        await killApp(app);
        onRemote(`git -C ~/code/${PROJECT_NAME} branch phone-live`);
        await pollFor(
          "a branch made on the box, answered by the box",
          async () => {
            const branches = await page.evaluate(
              (id) => window.electronAPI.projects.listLocalBranches(id).catch(() => []),
              projects.boxs.id,
            );
            return (branches as string[]).includes("phone-live") ? true : null;
          },
          STEP,
        );
        await expect(sidebarProject(page, PROJECT_NAME).first()).toBeVisible();
        // The desktop's project: still listed from what it last said, and
        // refused as away.
        await expect(sidebarProject(page, LOCAL_PROJECT).first()).toBeVisible();
        const refused = await pollFor(
          "the desktop's project refused as away",
          async () => {
            const code = await page.evaluate(
              (id) =>
                window.electronAPI.projects
                  .listLocalBranches(id)
                  .then(() => null)
                  .catch((err: { code?: string }) => err.code ?? "error"),
              projects.mine.id,
            );
            return code === "unavailable:host-away" ? code : null;
          },
          STEP,
        );
        expect(refused).toBe("unavailable:host-away");

        // 4. Remove the desktop's pairing from the Hosts sheet.
        await page.setViewportSize(PHONE);
        await page.getByTestId("phone-drawer-toggle").click();
        await page.getByTestId("hosts-row").click();
        const sheet = page.getByTestId("phone-hosts-sheet");
        await expect(sheet).toBeVisible();
        const row = sheet.locator(`[data-testid="phone-host-option"][data-room-id="${deskRoom}"]`);
        await row.getByTestId("phone-host-remove").click();
        await sheet.getByTestId("phone-host-remove-confirm").click();
        await expect(sheet.getByTestId("phone-host-option")).toHaveCount(1);
        await page.getByTestId("phone-hosts-close").click();

        await page.setViewportSize(DESK);
        await expect(sidebarProject(page, LOCAL_PROJECT)).toHaveCount(0, { timeout: STEP });
        await expect(sidebarProject(page, PROJECT_NAME).first()).toBeVisible();
        expect((await phoneProjects(page)).map((p) => p.hostId)).toEqual([boxRoom]);
      } catch (err) {
        console.log(`[phone-all-pairings.spec] phone log:\n${client.log.join("\n")}`);
        throw err;
      } finally {
        await client.close();
      }
    },
  );
});
