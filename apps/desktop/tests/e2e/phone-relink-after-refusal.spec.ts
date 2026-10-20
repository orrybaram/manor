import fs from "fs";
import path from "path";

import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect } from "./fixtures";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  APP_TARGET,
  installRemoteStubs,
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
import { closeSettings, openHostRow, pairBrowser, pairDevice, roomOf } from "./helpers/settings";

/**
 * A host that refuses the phone is linked again on its own.
 *
 * 1. The desktop clones a project onto the box. A browser opens the desktop's
 *    link only; its hello gets it a pairing with the box.
 * 2. **Reset.** The desktop resets the box's pairing keys: the box closes the
 *    phone's channel with 4401 and moves to a new room. The phone drops the
 *    pairing without declining the room, asks the desktop once, and holds a
 *    pairing with the box's new room in the same page load — no reload, no
 *    button. The box's project is answered under that room.
 * 3. **Revoked on the host.** The desktop revokes the phone's pairing on the
 *    box (`hosts.revokeDevice`). The phone is refused and asks again, but the
 *    desktop has blocked it there: no pairing comes back, not after a reload
 *    either. The Hosts sheet says "Only through <desktop>" with no button,
 *    and the desktop's row for the box names the phone under "Devices can
 *    reach". Turning that switch off and on lets it back in.
 * 4. **Removed by hand.** Removing the box's pairing on the phone declines the
 *    room: "Removed here · only through <desktop>", with Connect directly,
 *    which links it again.
 *
 * Needs the private-sshd target (`node scripts/test-remote-e2e.mjs`), as
 * `phone-linked-hosts.spec.ts` does: the box must reach the local relay.
 *
 * MANOR_E2E_EVIDENCE_DIR, when set, collects the screenshots there and
 * records the phone's video into it.
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

const PHONE = { width: 390, height: 844 };
const EVIDENCE = process.env.MANOR_E2E_EVIDENCE_DIR;

function storedRooms(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("manor.web.pairings") ?? "[]").map(
      (p: { roomId: string }) => p.roomId,
    ),
  );
}

function declined(page: Page): Promise<string[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("manor.web.declinedRooms") ?? "[]"));
}

/** The box's room as the desktop lists it now. */
function boxRoomOf(window: Page, hostId: string): Promise<string | null> {
  return window.evaluate(
    (id) =>
      window.electronAPI.hosts.list().then((l) => l.find((h) => h.hostId === id)?.roomId ?? null),
    hostId,
  );
}

/** The project's host on the phone, once it is listed exactly once. */
async function projectHostOnPhone(page: Page): Promise<string | null> {
  const all = await page.evaluate(async () =>
    (await window.electronAPI.projects.getAll()).map((p) => ({ name: p.name, hostId: p.hostId })),
  );
  const named = all.filter((p) => p.name === PROJECT_NAME);
  return named.length === 1 ? named[0].hostId : null;
}

async function shot(target: Page | Locator, testInfo: TestInfo, name: string): Promise<void> {
  const file = EVIDENCE ? path.join(EVIDENCE, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  // Off any button, so no hover shows.
  if ("mouse" in target) await target.mouse.move(1, 300);
  await target.screenshot({ path: file });
}

/**
 * A light theme for the evidence shots: a Ghostty theme file where the
 * app's theme manager looks under its HOME (GitHub Light's palette).
 */
const LIGHT_THEME = "E2E Light";

function installLightTheme(tempHome: string): void {
  const dir = path.join(tempHome, "Library", "Application Support", "ghostty", "themes");
  fs.mkdirSync(dir, { recursive: true });
  const palette = [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ];
  fs.writeFileSync(
    path.join(dir, LIGHT_THEME),
    [
      ...palette.map((c, i) => `palette = ${i}=${c}`),
      "background = #ffffff",
      "foreground = #1f2328",
      "cursor-color = #0969da",
      "selection-background = #dbe9f9",
      "selection-foreground = #1f2328",
      "",
    ].join("\n"),
  );
}

/**
 * Select `name` everywhere. The caller of `theme.setSelected` takes the
 * answer and the rest hear the broadcast, so each of the two asks once.
 */
async function selectTheme(window: Page, page: Page, name: string): Promise<void> {
  await page.evaluate((n) => window.electronAPI.theme.setSelected(n), name);
  await window.evaluate((n) => window.electronAPI.theme.setSelected(n), name);
  await page.waitForTimeout(1_000);
}

async function openHostsSheet(page: Page): Promise<Locator> {
  const sheet = page.getByTestId("phone-hosts-sheet");
  if (!(await sheet.isVisible().catch(() => false))) {
    await page.getByTestId("phone-drawer-toggle").click();
    await page.getByTestId("hosts-row").click();
    await expect(sheet).toBeVisible();
    // Let the drawer close and the sheet slide in before a screenshot.
    await page.waitForTimeout(1_000);
  }
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeHostsSheet(page: Page): Promise<void> {
  const sheet = page.getByTestId("phone-hosts-sheet");
  if (await sheet.isVisible().catch(() => false)) {
    await page.getByTestId("phone-hosts-close").click();
    await expect(sheet).not.toBeVisible();
  }
}

relayTest.describe("a phone a host refused", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 12 * STEP);

  relayTest(
    "is linked again after a reset, stays out after a revoke on the host, and comes back by hand",
    async ({ window, request, tempHome, relay }, testInfo) => {
      if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
      pointHostServerAtRelay(relay.url);

      // 1. A project on the box; the phone holds the desktop's link only.
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
      const firstBoxRoom = (await boxRoomOf(window, hostId)) as string;

      const desk = await pairBrowser(window, { label: "linked phone" });
      const section = await openHostRow(window, { hostId });
      await expect(section.getByTestId("host-phone-summary")).toContainText("relay connected", {
        timeout: 60_000,
      });
      await closeSettings(window);
      const deskRoom = roomOf(desk.link);

      const client = await openWebApp(desk.link, {
        viewport: PHONE,
        context: EVIDENCE ? { recordVideo: { dir: EVIDENCE, size: PHONE } } : undefined,
      });
      const page = client.page;
      try {
        await expect.poll(() => storedRooms(page), { timeout: 30_000 }).toEqual([
          deskRoom,
          firstBoxRoom,
        ]);
        await pollFor(
          "the box's project under the box's room",
          async () => ((await projectHostOnPhone(page)) === firstBoxRoom ? true : null),
          STEP,
        );
        let sheet = await openHostsSheet(page);
        await expect(
          sheet.locator(`[data-testid="phone-host-option"][data-room-id="${firstBoxRoom}"]`),
        ).toBeVisible();
        await shot(page, testInfo, "01-phone-hosts-linked");

        // 2. Reset: the box refuses the phone (4401) and moves room.
        // A marker on `window` that a reload would erase: the relink must
        // come in this page load.
        await page.evaluate(() => {
          (window as unknown as { __sameLoad: boolean }).__sameLoad = true;
        });
        await window.evaluate((id) => window.electronAPI.hosts.resetPairingKeys(id), hostId);
        const secondBoxRoom = await pollFor(
          "the box's new room on the desktop",
          async () => {
            const room = await boxRoomOf(window, hostId);
            return room && room !== firstBoxRoom ? room : null;
          },
          STEP,
        );
        // The phone asks again on its own while the box's relay comes back
        // (0/2/6/15 s): no reload, no button.
        await expect
          .poll(() => storedRooms(page), { timeout: 25_000 })
          .toEqual([deskRoom, secondBoxRoom]);
        expect(
          await page.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad),
        ).toBe(true);
        expect(await declined(page)).toEqual([]);
        await pollFor(
          "the box's project under the box's new room",
          async () => ((await projectHostOnPhone(page)) === secondBoxRoom ? true : null),
          STEP,
        );
        sheet = await openHostsSheet(page);
        await expect(
          sheet.locator(`[data-testid="phone-host-option"][data-room-id="${secondBoxRoom}"]`),
        ).toBeVisible({ timeout: STEP });
        await expect(sheet.getByTestId("phone-host-indirect")).toHaveCount(0);
        await shot(page, testInfo, "02-phone-hosts-relinked-after-reset");

        // 3. Revoked on the host: refused, and not linked again.
        const linked = await window.evaluate(
          (id) => window.electronAPI.hosts.serverStatus(id).then((v) => v.linkedDeviceIds),
          hostId,
        );
        expect(linked).toHaveLength(1);
        await window.evaluate(
          ([id, device]) => window.electronAPI.hosts.revokeDevice(id, device),
          [hostId, linked[0]] as const,
        );
        await expect.poll(() => storedRooms(page), { timeout: STEP }).toEqual([deskRoom]);
        const indirect = sheet
          .getByTestId("phone-host-indirect")
          .filter({ hasText: APP_TARGET });
        await expect(indirect).toBeVisible({ timeout: STEP });
        await expect(indirect).toContainText(/Only through /);
        await expect(indirect).not.toContainText("Removed here");
        await expect(indirect.getByTestId("phone-host-connect-directly")).toHaveCount(0);
        // The refusal's one ask has been answered by now; nothing came of it.
        await page.waitForTimeout(10_000);
        expect(await storedRooms(page)).toEqual([deskRoom]);
        expect(await declined(page)).toEqual([]);
        await shot(page, testInfo, "03-phone-hosts-only-through-desktop-after-revoke");

        // A fresh hello asks again; the desktop still says no.
        await page.reload();
        await pollFor(
          "the box's project through the desktop after reload",
          async () => ((await projectHostOnPhone(page)) !== null ? true : null),
          STEP,
        );
        await page.waitForTimeout(10_000);
        expect(await storedRooms(page)).toEqual([deskRoom]);

        const row = await openHostRow(window, { hostId });
        const hint = row.getByTestId("host-blocked-devices");
        await expect(hint).toHaveText(
          `linked phone was removed on ${APP_TARGET}. Turn the switch off and on to pair it again.`,
          { timeout: STEP },
        );
        await hint.scrollIntoViewIfNeeded();
        await shot(row, testInfo, "04-desktop-host-row-blocked-hint");
        await shot(window, testInfo, "04b-desktop-settings-hosts-blocked");
        const darkTheme = await window.evaluate(() => window.electronAPI.theme.getSelectedName());
        if (EVIDENCE) installLightTheme(tempHome);
        const lightTheme = EVIDENCE ? LIGHT_THEME : null;
        if (lightTheme) {
          await openHostsSheet(page);
          await selectTheme(window, page, lightTheme);
          await shot(page, testInfo, "03-light-phone-hosts-only-through-desktop-after-revoke");
          await hint.scrollIntoViewIfNeeded();
          await shot(row, testInfo, "04-light-desktop-host-row-blocked-hint");
          await selectTheme(window, page, darkTheme);
          await closeHostsSheet(page);
        }

        // A second device, revoked on the box too: the hint names both.
        const tablet = await pairDevice(window, { label: "tablet" });
        const tabletClient = await openWebApp(tablet.link, { viewport: { width: 1280, height: 800 } });
        try {
          await expect
            .poll(() => storedRooms(tabletClient.page), { timeout: STEP })
            .toEqual([roomOf(tablet.link), secondBoxRoom]);
          const tabletLinks = await window.evaluate(
            (id) => window.electronAPI.hosts.serverStatus(id).then((v) => v.linkedDeviceIds),
            hostId,
          );
          expect(tabletLinks).toHaveLength(1);
          await window.evaluate(
            ([id, device]) => window.electronAPI.hosts.revokeDevice(id, device),
            [hostId, tabletLinks[0]] as const,
          );
          await expect
            .poll(() => storedRooms(tabletClient.page), { timeout: STEP })
            .toEqual([roomOf(tablet.link)]);
        } finally {
          await tabletClient.close();
        }
        await openHostRow(window, { hostId });
        await expect(hint).toHaveText(
          new RegExp(
            `^(linked phone and tablet|tablet and linked phone) were removed on ${APP_TARGET}\\. ` +
              "Turn the switch off and on to pair them again\\.$",
          ),
          { timeout: STEP },
        );
        await hint.scrollIntoViewIfNeeded();
        await shot(row, testInfo, "04c-desktop-host-row-blocked-hint-two-devices");
        if (lightTheme) {
          await selectTheme(window, page, lightTheme);
          await hint.scrollIntoViewIfNeeded();
          await shot(row, testInfo, "04c-light-desktop-host-row-blocked-hint-two-devices");
          await selectTheme(window, page, darkTheme);
        }

        // The switch off and on lets it back in.
        const toggle = row.getByTestId("host-link-phones-toggle");
        await toggle.click();
        await expect(toggle).toHaveAttribute("data-state", "unchecked");
        await toggle.click();
        await expect(toggle).toHaveAttribute("data-state", "checked");
        await expect(hint).toHaveCount(0, { timeout: STEP });
        await shot(row, testInfo, "05-desktop-host-row-after-switch");
        await closeSettings(window);

        await page.reload();
        await expect
          .poll(() => storedRooms(page), { timeout: STEP })
          .toEqual([deskRoom, secondBoxRoom]);
        await pollFor(
          "the box's project under the box's room after the switch",
          async () => ((await projectHostOnPhone(page)) === secondBoxRoom ? true : null),
          STEP,
        );
        sheet = await openHostsSheet(page);
        await expect(
          sheet.locator(`[data-testid="phone-host-option"][data-room-id="${secondBoxRoom}"]`),
        ).toBeVisible();
        await shot(page, testInfo, "06-phone-hosts-relinked-after-switch");

        // 4. Removed by hand: declined, with Connect directly.
        const boxRow = sheet.locator(
          `[data-testid="phone-host-option"][data-room-id="${secondBoxRoom}"]`,
        );
        await boxRow.getByTestId("phone-host-remove").click();
        await sheet.getByTestId("phone-host-remove-confirm").click();
        const removed = sheet
          .getByTestId("phone-host-indirect")
          .filter({ hasText: APP_TARGET });
        await expect(removed).toContainText(/Removed here · only through /, { timeout: STEP });
        const connect = removed.getByTestId("phone-host-connect-directly");
        await expect(connect).toBeEnabled({ timeout: STEP });
        expect(await declined(page)).toEqual([secondBoxRoom]);
        expect(await storedRooms(page)).toEqual([deskRoom]);
        await shot(page, testInfo, "07-phone-hosts-removed-by-hand");
        if (lightTheme) {
          await selectTheme(window, page, lightTheme);
          await shot(page, testInfo, "07-light-phone-hosts-removed-by-hand");
          await selectTheme(window, page, darkTheme);
        }

        await connect.click();
        await expect
          .poll(() => storedRooms(page), { timeout: STEP })
          .toEqual([deskRoom, secondBoxRoom]);
        expect(await declined(page)).toEqual([]);
        await expect(
          sheet.locator(`[data-testid="phone-host-option"][data-room-id="${secondBoxRoom}"]`),
        ).toBeVisible({ timeout: STEP });
        await expect(sheet.getByTestId("phone-host-indirect")).toHaveCount(0);
        await pollFor(
          "the box's project under the box's room after Connect directly",
          async () => ((await projectHostOnPhone(page)) === secondBoxRoom ? true : null),
          STEP,
        );
        await shot(page, testInfo, "08-phone-hosts-connected-directly");
        await closeHostsSheet(page);
      } catch (err) {
        console.log(`[phone-relink-after-refusal.spec] phone log:\n${client.log.join("\n")}`);
        if (EVIDENCE) {
          await page.screenshot({ path: path.join(EVIDENCE, "zz-failure-phone.png") }).catch(() => {});
          await window.screenshot({ path: path.join(EVIDENCE, "zz-failure-desktop.png") }).catch(() => {});
        }
        throw err;
      } finally {
        await client.close();
      }
    },
  );
});
