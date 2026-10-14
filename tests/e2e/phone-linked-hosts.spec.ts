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
import { closeSettings, openRemoteControlSettings, pairBrowser } from "./helpers/settings";

/**
 * One pairing covers every host (ADR-228 D9): a phone paired with the
 * desktop only is paired with the desktop's hosts too, and keeps reaching
 * them with the desktop gone.
 *
 * 1. The desktop clones a project onto the box.
 * 2. One browser opens the desktop's link — and only that. Its hello from
 *    the desktop asks for pairings with the desktop's hosts
 *    (`remoteControl.linkHostPairings`); the box's room joins the stored
 *    list and the page dials it. The box's project is answered by that
 *    pairing, under the box's room, and listed once.
 * 3. Settings lists the phone on the box "via This Mac".
 * 4. The desktop stops. The box's project stays live: the phone asks the box
 *    for a branch made on it after the desktop went, and gets it.
 *
 * Needs the private-sshd target (`node scripts/test-remote-e2e.mjs`), as
 * `phone-all-pairings.spec.ts` does: the box must reach the local relay.
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

const DESK = { width: 1280, height: 800 };

/** The room a pairing link dials: `#relay=<roomId>.<key>&t=<token>`. */
function roomOf(link: string): string {
  const relay = new URLSearchParams(new URL(link).hash.slice(1)).get("relay") ?? "";
  return relay.slice(0, relay.indexOf("."));
}

function storedRooms(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("manor.web.pairings") ?? "[]").map(
      (p: { roomId: string }) => p.roomId,
    ),
  );
}

relayTest.describe("a phone paired with the desktop only", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 8 * STEP);

  relayTest(
    "is paired with the desktop's host too, and reaches it with the desktop stopped",
    async ({ app, window, request, tempHome, relay }) => {
      pointHostServerAtRelay(relay.url);

      // 1. A project on the box.
      await openRemoteProject(window, request, tempHome);
      const hostId = await pollFor(
        "the box's server room on the desktop",
        async () => {
          const hosts = await window.evaluate(() => window.electronAPI.hosts.list());
          const box = hosts.find((h) => h.hostId !== "local" && typeof h.roomId === "string");
          return box?.hostId ?? null;
        },
        STEP,
      );
      const boxRoom = (await window.evaluate(
        (id) => window.electronAPI.hosts.list().then((l) => l.find((h) => h.hostId === id)?.roomId),
        hostId,
      )) as string;

      // 2. The desktop's link, and nothing else.
      const desk = await pairBrowser(window, { label: "linked phone" });
      // The box's relay is up, so the minted pairing works as soon as it lands.
      const section = window.getByTestId("host-phone-access").filter({ hasText: APP_TARGET });
      await expect(section.getByTestId("host-phone-summary")).toContainText("relay connected", {
        timeout: 60_000,
      });
      await expect(section.getByTestId("host-phone-summary")).not.toContainText(
        "relay not connected",
      );
      await expect(section.getByTestId("host-link-phones-toggle")).toHaveAttribute(
        "data-state",
        "checked",
      );
      await closeSettings(window);
      const deskRoom = roomOf(desk.link);

      const client = await openWebApp(desk.link, { viewport: DESK });
      try {
        const page = client.page;
        await expect.poll(() => storedRooms(page), { timeout: 30_000 }).toEqual([deskRoom, boxRoom]);

        // The box's project, from the box's own pairing, listed once.
        const boxProject = await pollFor(
          "the box's project under the box's room",
          async () => {
            const all = await page.evaluate(async () =>
              (await window.electronAPI.projects.getAll()).map((p) => ({
                id: p.id,
                name: p.name,
                hostId: p.hostId,
              })),
            );
            const named = all.filter((p) => p.name === PROJECT_NAME);
            return named.length === 1 && named[0].hostId === boxRoom ? named[0] : null;
          },
          STEP,
        );
        await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
          timeout: 30_000,
        });

        // 3. The box lists the phone, via this desktop.
        await openRemoteControlSettings(window);
        await expect(
          section.getByTestId("remote-device-row").filter({ hasText: "linked phone" }),
        ).toContainText("via This Mac", { timeout: STEP });
        await closeSettings(window);

        // 4. The desktop stops; the box answers on its own.
        await killApp(app);
        onRemote(`git -C ~/code/${PROJECT_NAME} branch linked-live`);
        await pollFor(
          "a branch made on the box, answered by the box",
          async () => {
            const branches = await page.evaluate(
              (id) => window.electronAPI.projects.listLocalBranches(id).catch(() => []),
              boxProject.id,
            );
            return (branches as string[]).includes("linked-live") ? true : null;
          },
          STEP,
        );
        await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible();
      } catch (err) {
        console.log(`[phone-linked-hosts.spec] phone log:\n${client.log.join("\n")}`);
        throw err;
      } finally {
        await client.close();
      }
    },
  );
});
