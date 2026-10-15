import path from "path";

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, openTerminalTab } from "./fixtures";
import { stripAnsi } from "./helpers/ansi";
import { freezeApp, thawApp } from "./helpers/freeze";
import { readSession } from "./helpers/local-api";
import { agentNotifications } from "./helpers/notifications";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  APP_TARGET,
  REMOTE_AGENT,
  installRemoteStubs,
  killAppSsh,
  onRemote,
  pointHostServerAtRelay,
  pollFor,
  reachRelayFromBox,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  setAppTargetReachable,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  PROJECT_NAME,
  STEP,
  agentOnPane,
  awaitRemotePrompt,
  hostStatus,
  openRemoteProject,
} from "./helpers/remote-project";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, paneText, runInTerminal } from "./helpers/terminal";

/**
 * A closed lid, the way a laptop does it (ADR-231 D4): the whole desktop
 * freezes mid-run, its network goes, the box works on with a phone
 * watching, and the desktop thaws and recovers with no Retry.
 *
 * 1. Setup. A project on the box with two panes: the stub agent in one, a
 *    ticker (a numbered line a second) in the other; and a project on the
 *    desktop. A phone paired with the desktop only, linked to the box's
 *    room on its first hello (`linkHostPairings`, as in
 *    `phone-linked-hosts.spec.ts`).
 * 2. The lid closes. Every process of the app is stopped (`SIGSTOP`, ssh
 *    aside), then its network is cut: the alias unreachable, its ssh
 *    killed. The frozen desktop's relay socket goes silent, not closed.
 * 3. While it is closed, the box works. Hooks take the agent to working
 *    and requires-input, each seen live on the phone through the box's
 *    pairing; the phone types an answer into the agent's pane, and the
 *    agent on the box echoes it; a Stop takes it to responded. The ticker
 *    keeps writing. On the phone the desktop's project reads as away within
 *    30 s, and the box's stays live.
 * 4. The lid opens. The alias is reachable again and the tree thaws; no
 *    `retryHost`. Within the reconnect backoff's ceiling (30 s) plus a step
 *    the host reads connected and the offline banner is gone. The agent's
 *    final status is responded, with one notification for the absence; the
 *    ticker's lines from the absence are in its pane, each once; and the
 *    phone reaches the desktop again.
 *
 * Not faked: `powerMonitor`'s `resume` (a `SIGSTOP` sends none, so recovery
 * is proved without it) and push delivery (there is no push service here).
 *
 * Runs on the private sshd and in `--docker`: a container reaches the local
 * relay through a reverse forward on the side channel (`reachRelayFromBox`).
 */

const skipReason = remoteSkipReason();
relayTest.skip(skipReason !== null, skipReason ?? "");

relayTest.describe.configure({ mode: "serial" });

relayTest.beforeAll(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

relayTest.afterEach(() => {
  // A test that failed while the app's alias was blocked must not leave it so.
  setAppTargetReachable(true);
});

const LOCAL_PROJECT = "desk-e2e";
const DESK = { width: 1280, height: 800 };
/** The reconnect backoff's ceiling: a thawed desktop redials within it. */
const BACKOFF_CEILING = 30_000;
/** How long the phone may take to call a silent desktop away. */
const AWAY_WITHIN = 30_000;
const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 1; done';

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

/** Every `tick N` in `text`, in order. */
function ticks(text: string): number[] {
  return [...text.matchAll(/^tick (\d+)\s*$/gm)].map((m) => Number(m[1]));
}

/**
 * Whether the phone's sidebar dims the project named `name` as away: its
 * container carries `data-host-offline` (ADR-192 §5, ADR-228 D6).
 */
function projectAway(page: Page, name: string): Promise<boolean> {
  return page.evaluate((projectName) => {
    const header = [...document.querySelectorAll('[data-testid="project-header"]')].find((h) =>
      h.textContent?.includes(projectName),
    );
    if (!header) throw new Error(`no project "${projectName}" in the phone's sidebar`);
    return header.closest("[data-host-offline]") !== null;
  }, name);
}

/** The ticker's pane, read far enough back to hold every line it wrote. */
async function tickerTicks(
  request: APIRequestContext,
  tempHome: string,
  paneId: string,
): Promise<number[]> {
  return ticks(await readSession(request, tempHome, paneId, 5_000));
}

relayTest.describe("the lid closes", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 10 * STEP);

  relayTest(
    "a frozen, cut-off desktop: the box works on with a phone watching, and the desktop thaws without a Retry",
    async ({ app, window, request, tempHome, relay }, testInfo) => {
      const closeForward = await reachRelayFromBox(relay.url);
      try {
        pointHostServerAtRelay(relay.url);

        // 1. Setup. The ticker's pane first, then the agent's, which stays
        // the active tab: the phone opens on it.
        const { hostId, paneId: tickerPane } = await openRemoteProject(window, request, tempHome);
        await runInTerminal(window, TICKER);
        await expect
          .poll(async () => (await tickerTicks(request, tempHome, tickerPane)).length, {
            timeout: STEP,
          })
          .toBeGreaterThan(1);

        await openTerminalTab(window);
        const agentPane = await activePaneId(window);
        expect(agentPane).not.toBe(tickerPane);
        await awaitRemotePrompt(window, request, tempHome, agentPane);
        const agentSession = `lid-${Date.now()}`;
        await runInTerminal(window, `${REMOTE_AGENT} --session ${agentSession}`);
        const agent = await pollFor(
          "the remote agent thinking",
          async () => {
            const a = await agentOnPane(request, tempHome, agentPane);
            return a?.lastAgentStatus === "thinking" ? a : null;
          },
          STEP,
        );

        await window.evaluate(
          ([name, dir]) => window.electronAPI.projects.add(name, dir),
          [LOCAL_PROJECT, path.join(tempHome, "test-project")] as const,
        );

        const boxRoom = await pollFor(
          "the box's server room on the desktop",
          () =>
            window.evaluate(
              (id) =>
                window.electronAPI.hosts
                  .list()
                  .then((l) => l.find((h) => h.hostId === id)?.roomId ?? null),
              hostId,
            ),
          STEP,
        );

        // The desktop's link only; the box's room joins on its first hello.
        const desk = await pairBrowser(window, { label: "lid-closed phone" });
        const section = window.getByTestId("host-phone-access").filter({ hasText: APP_TARGET });
        await expect(section.getByTestId("host-phone-summary")).toContainText("relay connected", {
          timeout: 60_000,
        });
        await expect(section.getByTestId("host-phone-summary")).not.toContainText(
          "relay not connected",
        );
        await closeSettings(window);
        const deskRoom = roomOf(desk.link);

        const before = agentNotifications(tempHome, agent.id).length;

        const client = await openWebApp(desk.link, { viewport: DESK });
        let frozen: number[] = [];
        try {
          const page = client.page;
          await expect.poll(() => storedRooms(page), { timeout: 30_000 }).toEqual([deskRoom, boxRoom]);
          await expect(page.getByText(LOCAL_PROJECT, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          expect(await projectAway(page, LOCAL_PROJECT)).toBe(false);
          expect(await projectAway(page, PROJECT_NAME)).toBe(false);

          // The agent, in the phone's own sidebar: its row's dot, or its
          // spinner for thinking and working. A bridge read is no use with
          // the desktop frozen: a merged read waits on every server it still
          // calls reachable, the silent desktop too.
          const phoneAgentId = await pollFor(
            "the agent on the phone",
            () =>
              page.evaluate(
                async (pane) =>
                  (await window.electronAPI.agents.getActive()).find(
                    (a: { paneId: string | null }) => a.paneId === pane,
                  )?.id ?? null,
                agentPane,
              ),
            STEP,
          );
          const phoneStatus = () =>
            page.evaluate((id) => {
              const row = document.querySelector(
                `[data-testid="sidebar-agent-row"][data-agent-id="${CSS.escape(id)}"]`,
              );
              if (!row) return "no row";
              const dot = row.querySelector<HTMLElement>('[data-testid="agent-dot"]');
              if (dot) return dot.dataset.status ?? "no status";
              if (row.querySelector('[title="Agent working"]')) return "working";
              if (row.querySelector('[title="Agent thinking"]')) return "thinking";
              return "none";
            }, phoneAgentId);
          const statusOnPhone = async (status: string) => {
            let last: string | null = null;
            await pollFor(
              `the agent ${status} on the phone`,
              async () => {
                last = await phoneStatus();
                return last === status ? true : null;
              },
              STEP,
            ).catch((err: Error) => {
              throw new Error(`${err.message} (last read: ${last})`);
            });
          };
          await statusOnPhone("thinking");

          const lastTickBefore = Math.max(...(await tickerTicks(request, tempHome, tickerPane)));

          // 2. The lid closes: the app stops where it is, then the network goes.
          frozen = freezeApp(app);
          const frozenAt = Date.now();
          setAppTargetReachable(false);
          killAppSsh();

          // 3. The box works, and the phone sees it through the box's pairing.
          const fire = (event: string) =>
            onRemote(`"$HOME/.manor-e2e/bin/fire-hook" ${agentPane} ${event} ${agentSession}`);
          fire("PreToolUse");
          await statusOnPhone("working");
          fire("Notification");
          await statusOnPhone("requires_input");

          // The phone answers, in the agent's pane; the agent on the box
          // echoes it, which a local echo never would.
          // The agent's row takes the phone to its pane.
          const answer = "answered with the lid closed";
          await page
            .locator(`[data-testid="sidebar-agent-row"][data-agent-id="${phoneAgentId}"]`)
            .click();
          const pane = page
            .locator(
              `[data-testid="workspace-pane"][data-pane-id="${agentPane}"] [data-testid="terminal-pane"]`,
            )
            .first();
          await expect(pane).toBeVisible({ timeout: 30_000 });
          await pane.click();
          await page.keyboard.type(answer);
          await page.keyboard.press("Enter");
          await expect
            .poll(async () => stripAnsi(await paneText(page, agentPane)), { timeout: 20_000 })
            .toContain(`received: ${answer}`);

          fire("Stop");
          await statusOnPhone("responded");

          // The desktop's project reads as away; the box's stays live. The
          // phone's transport pings the silent desktop and gives up on its
          // line (ADR-231 D8), well before the relay reaps it (90 s).
          let awayAfterMs: number | null = null;
          try {
            await expect
              .poll(() => projectAway(page, LOCAL_PROJECT), {
                timeout: Math.max(0, AWAY_WITHIN - (Date.now() - frozenAt)),
              })
              .toBe(true);
            awayAfterMs = Date.now() - frozenAt;
          } catch {
            // Not within the 30 s: recorded, and failed just below.
          }
          console.log(
            `[lid-closed] desktop away on the phone: ${awayAfterMs === null ? `not within ${AWAY_WITHIN} ms` : `${awayAfterMs} ms`} after the freeze`,
          );
          expect(awayAfterMs, `the desktop's project away on the phone within ${AWAY_WITHIN} ms`).not.toBeNull();
          expect(await projectAway(page, PROJECT_NAME)).toBe(false);

          // 4. The lid opens. No Retry: the app finds its own way back.
          setAppTargetReachable(true);
          thawApp(frozen);
          frozen = [];
          const thawedAt = Date.now();
          console.log(`[lid-closed] frozen for ${thawedAt - frozenAt} ms`);

          await pollFor(
            "the host back with no Retry",
            async () => ((await hostStatus(window, hostId))?.status === "connected" ? true : null),
            BACKOFF_CEILING + STEP,
          );
          console.log(`[lid-closed] host connected ${Date.now() - thawedAt} ms after the thaw`);
          await expect(window.getByTestId("host-offline-banner")).not.toBeVisible({ timeout: STEP });

          await pollFor(
            "the replayed final status",
            async () => {
              const a = await agentOnPane(request, tempHome, agentPane);
              return a?.lastAgentStatus === "responded" ? a : null;
            },
            STEP,
          );
          await expect
            .poll(() => agentNotifications(tempHome, agent.id).length - before, { timeout: STEP })
            .toBe(1);

          // The ticker's lines from the absence, each once.
          const seen = await pollFor(
            "the ticker's lines from the absence on the desktop",
            async () => {
              const t = (await tickerTicks(request, tempHome, tickerPane));
              return t.length > 0 && Math.max(...t) > lastTickBefore + (thawedAt - frozenAt) / 1000 - 5
                ? t
                : null;
            },
            STEP,
          );
          const first = seen[0];
          expect(first).toBeLessThanOrEqual(lastTickBefore + 1);
          expect(seen).toEqual(seen.map((_, i) => first + i));

          // The phone reaches the desktop again.
          await expect.poll(() => projectAway(page, LOCAL_PROJECT), { timeout: STEP }).toBe(false);
          expect(await projectAway(page, PROJECT_NAME)).toBe(false);

          // Nothing late behind the one notification.
          expect(
            agentNotifications(tempHome, agent.id)
              .slice(before)
              .map((n) => n.kind),
          ).toEqual(["agent-responded"]);
        } catch (err) {
          console.log(`[lid-closed.spec] phone log:\n${client.log.join("\n")}`);
          await client.page
            .screenshot({ path: testInfo.outputPath("phone.png") })
            .catch(() => {});
          throw err;
        } finally {
          if (frozen.length > 0) {
            setAppTargetReachable(true);
            thawApp(frozen);
          }
          await client.close();
        }
      } finally {
        closeForward();
      }
    },
  );
});
