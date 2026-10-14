import type { ElectronApplication, Page } from "@playwright/test";

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
 * Linear (ADR-228 D10) rides along: it is connected on the desktop only (its
 * GraphQL answered by a stub in main, there being no Linear here), and the
 * box's server has it off. The phone's Linear call is answered by the
 * desktop; with the desktop stopped it is refused, saying the desktop is
 * away. This checks the routing by each server's `isConnected` answer, and
 * the call with no host in mind (`TasksView`'s); a call on behalf of the box
 * goes through the same choice, in `src/bridge/__tests__/router.test.ts`.
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

/** The stub viewer main's Linear answers with. */
const LINEAR_VIEWER = { name: "E2E Linear", email: "e2e@linear.test" };

/**
 * Answer main's Linear GraphQL with `viewer` alone; every other fetch goes
 * out as before. Main's `LinearManager` calls the global `fetch` per call.
 */
async function stubDesktopLinear(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, viewer) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.linear.app/")) return real(input, init);
      return new Response(JSON.stringify({ data: { viewer } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }, LINEAR_VIEWER);
}

/** The phone's `linear.getViewer()`: its answer's name, or the refusal. */
function phoneLinearViewer(page: Page): Promise<string> {
  return page.evaluate(() =>
    Promise.race([
      window.electronAPI.linear.getViewer().then(
        (v) => `viewer:${v.name}`,
        (err: unknown) => `refused:${err instanceof Error ? err.message : String(err)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5_000)),
    ]),
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

      // Linear on the desktop only, before the phone first asks who has it.
      await stubDesktopLinear(app);
      await window.evaluate(() => window.electronAPI.linear.connect("lin_api_e2e"));

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

        // Linear, which the box's server does not have, answered by the desktop.
        await pollFor(
          "the phone's Linear call answered by the desktop",
          async () => ((await phoneLinearViewer(page)) === `viewer:${LINEAR_VIEWER.name}` ? true : null),
          STEP,
        );

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

        // Linear now has nowhere to go, and says why.
        const refusal = await pollFor(
          "the phone's Linear call refused with the desktop away",
          async () => {
            const answer = await phoneLinearViewer(page);
            return answer.startsWith("refused:") && answer.includes("is away") ? answer : null;
          },
          STEP,
        );
        expect(refusal).toContain("no host has it turned on");
      } catch (err) {
        console.log(`[phone-linked-hosts.spec] phone log:\n${client.log.join("\n")}`);
        throw err;
      } finally {
        await client.close();
      }
    },
  );
});
