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
 * box's server has it off. The box's project is given a team on the desktop
 * (`linear.associateProject`, written on the box). The phone's Tasks view
 * lists that project's issues on behalf of the box (`onBehalfOf`): the box
 * has no Linear, so the desktop that lists it answers. A call with no host
 * in mind is answered by the desktop too; with the desktop stopped it is
 * refused, saying the desktop is away. The refusal for a call on behalf of
 * the box is not reached from the page then — Tasks shows its setup hint
 * once no server has Linear — and is in `src/bridge/__tests__/`.
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

/** The one issue main's stub Linear lists, whatever the team. */
const LINEAR_ISSUE = {
  id: "e2e-issue",
  identifier: "E2E-1",
  title: "E2E issue answered for the box",
  url: "https://linear.app/e2e/issue/E2E-1",
  branchName: "e2e-1",
  priority: 2,
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const LINEAR_TEAM = { teamId: "e2e-team", teamName: "E2E", teamKey: "E2E" };

/**
 * Answer main's Linear GraphQL with `viewer`, and one issue for either issue
 * list; every other fetch goes out as before. Main's `LinearManager` calls
 * the global `fetch` per call.
 */
async function stubDesktopLinear(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, { viewer, issue }) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.linear.app/")) return real(input, init);
      const query = String((JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? "");
      const data = query.includes("assignedIssues")
        ? { viewer: { assignedIssues: { nodes: [issue] } } }
        : query.includes("issues(")
          ? { issues: { nodes: [issue] } }
          : { viewer };
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }, { viewer: LINEAR_VIEWER, issue: LINEAR_ISSUE });
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
      // The box's project gets a team: a write to the box, by project.
      const associated = await window.evaluate(
        async ({ name, team }) => {
          const project = (await window.electronAPI.projects.getAll()).find((p) => p.name === name);
          return project ? window.electronAPI.linear.associateProject(project.id, team) : false;
        },
        { name: PROJECT_NAME, team: LINEAR_TEAM },
      );
      expect(associated).toBe(true);

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

        // The box's project's issues, listed on behalf of the box: the box has
        // no Linear, so the desktop that lists it answers (D10).
        await pollFor(
          "the box's project carrying its team on the phone",
          async () => {
            const teams = await page.evaluate(
              async (id) =>
                (await window.electronAPI.projects.getAll()).find((p) => p.id === id)
                  ?.linearAssociations.map((a) => a.teamId) ?? [],
              boxProject.id,
            );
            return teams.includes(LINEAR_TEAM.teamId) ? true : null;
          },
          STEP,
        );
        await page.getByTestId("tasks-row").click();
        await expect(page.getByTestId("tasks-view")).toBeVisible();
        await expect(page.getByText(LINEAR_ISSUE.title).first()).toBeVisible({ timeout: STEP });

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
