import { spawnSync } from "child_process";

import type { Page } from "@playwright/test";

import { expect, killApp } from "./fixtures";
import { stripAnsi } from "./helpers/ansi";
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
  openRemoteProject,
} from "./helpers/remote-project";
import { closeSettings, openHostRow, pairBrowser, roomOf } from "./helpers/settings";
import { paneText } from "./helpers/terminal";

/**
 * Automations with the lid closed for good: a cron automation on a
 * remote host fires with the desktop quit, and the paired phone sees the
 * agent it started (#508, the end-to-end proof of #501).
 *
 * 1. Setup, as `lid-closed.spec.ts`: the desktop opens a project on the box
 *    (so it adopts the box's host server, which automation writes need), and
 *    sets the project's agent command to the box's stub agent. A phone
 *    paired with the desktop only is linked to the box's room on its first
 *    hello (`linkHostPairings`, as in `phone-linked-hosts.spec.ts`) and lists
 *    the box's project.
 * 2. On the box, its own `manor` CLI (answered by the host server) creates an
 *    every-minute automation in UTC, enabled.
 * 3. The desktop quits: `app.close()` (a kill if that hangs), and no ssh of
 *    its is left. The phone stays open, on the box's pairing alone.
 * 4. Within 2.5 minutes the box lists a started run fired after the quit.
 *    The phone shows the project's "Automations" folder holding a workspace
 *    named "E2E nightly · <Mon D HH:mm>", and opening the run's agent shows
 *    the stub agent's output in its pane.
 * 5. The automation is paused (it stops firing), then deleted.
 *
 * The stub agent: a run's command is the project's agent command when
 * `getConnectorForCommand` reads it as the automation's kind, else the
 * kind's default (`claude --dangerously-skip-permissions`, which the box
 * does not have). `REMOTE_AGENT` (`~/.manor-e2e/bin/manor-e2e-agent`) names
 * no connector, so it falls through to `claude`, the kind a create defaults
 * to: the project's agent command is used as is, typed into the run's
 * shell, which expands the `~`. No `claude` stub on the box's PATH, so a
 * run that ignored the project's command would fail here rather than pass.
 * The stub's hooks make it thinking, so the overlap rule skips later
 * occurrences instead of piling up workspaces.
 *
 * Runs on the private sshd and in `--docker` (the relay reaches the box
 * through `reachRelayFromBox`). Slow on purpose: up to a minute waiting for
 * the box's clock to start a minute, and up to two more for the run.
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
  setAppTargetReachable(true);
});

const DESK = { width: 1280, height: 800 };
const AUTOMATION_NAME = "E2E nightly";
const PROMPT = "say hello";
/** How long after the quit a run of an every-minute automation must have started. */
const FIRE_WITHIN = 150_000;
/** The box's `manor` CLI, answered by its host server (as in `host-ownership.spec.ts`). */
const BOX_MANOR =
  'MANOR_CONTROL_PORT_FILE="$HOME/.manor/remote/control-port" "$HOME/.manor/bin/manor"';
const RUN_NAME = /^E2E nightly · [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}/;

/** Run the box's `manor` CLI with `args` (already shell-quoted). */
function boxManor(args: string, opts: { allowFailure?: boolean } = {}) {
  return onRemote(`${BOX_MANOR} ${args}`, { timeoutMs: 60_000, ...opts });
}

/** Single-quote `value` for a POSIX shell. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The box's clock, in ms. Runs are stamped by it, so the quit is too. */
function boxNow(): number {
  return Number(onRemote('node -e "process.stdout.write(String(Date.now()))"').stdout.trim());
}

interface RunLine {
  firedAt: string;
  trigger: string;
  outcome: string;
  workspacePath: string | null;
  agentId: string | null;
  paneId: string | null;
  raw: string;
}

/**
 * `list-automation-runs`' lines (`runLine` in `electron/mcp/tools-automations.ts`):
 * `<firedAt>  <trigger>  <what>[  (workspace <path>, agent <id> | pane <id>)]`.
 */
function parseRuns(stdout: string): RunLine[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line))
    .map((raw) => {
      const m = /^(\S+) {2}(\S+) {2}(.*?)(?: {2}\((.*)\))?$/.exec(raw);
      const where = m?.[4] ?? "";
      return {
        firedAt: m?.[1] ?? "",
        trigger: m?.[2] ?? "",
        outcome: (m?.[3] ?? "").split(/[,:]/)[0],
        workspacePath: /(?:^|, )workspace (.+?)(?:, (?:agent|pane) |$)/.exec(where)?.[1] ?? null,
        agentId: /(?:^|, )agent (\S+)$/.exec(where)?.[1] ?? null,
        paneId: /(?:^|, )pane (\S+)$/.exec(where)?.[1] ?? null,
        raw,
      };
    });
}

function storedRooms(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("manor.web.pairings") ?? "[]").map(
      (p: { roomId: string }) => p.roomId,
    ),
  );
}

/** Whether any ssh the app opened to the box is still running. */
function appSshAlive(): boolean {
  return (
    spawnSync("pgrep", ["-f", `manor-ssh-[^ ]*/config .*${APP_TARGET}( |$)`]).status === 0
  );
}

/** A folder header row in the sidebar (`FolderItem`), as `sidebar-multi-select.spec.ts` finds one. */
const folderHeader = (page: Page, name: string) =>
  page.locator("[data-sidebar-row][aria-expanded]:not([data-testid])").filter({ hasText: name });

relayTest.describe("automations with the desktop quit", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 12 * STEP);

  relayTest(
    "an every-minute automation on the box fires with the desktop quit, and the phone sees its agent",
    async ({ app, window, request, tempHome, relay }, testInfo) => {
      const closeForward = await reachRelayFromBox(relay.url);
      let automationId: string | null = null;
      try {
        pointHostServerAtRelay(relay.url);

        // 1. Setup. The project on the box runs the stub agent.
        const { hostId } = await openRemoteProject(window, request, tempHome, {
          agentCommand: REMOTE_AGENT,
        });
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

        // The project as the box's own server holds it: its id, and the
        // agent command the desktop wrote through to it.
        const boxProject = await pollFor(
          "the box's project with the stub agent command",
          () => {
            const projects = JSON.parse(boxManor("api GET /projects").stdout) as {
              id: string;
              name: string;
              agentCommand: string | null;
            }[];
            const p = projects.find((x) => x.name === PROJECT_NAME);
            return p?.agentCommand === REMOTE_AGENT ? p : null;
          },
          STEP,
          1_000,
        );

        const desk = await pairBrowser(window, { label: "automations phone" });
        const section = await openHostRow(window, { hostId });
        await expect(section.getByTestId("host-phone-summary")).toContainText("relay connected", {
          timeout: 60_000,
        });
        await expect(section.getByTestId("host-phone-summary")).not.toContainText(
          "relay not connected",
        );
        await closeSettings(window);
        const deskRoom = roomOf(desk.link);

        const client = await openWebApp(desk.link, { viewport: DESK });
        try {
          const page = client.page;
          await expect.poll(() => storedRooms(page), { timeout: 30_000 }).toEqual([deskRoom, boxRoom]);
          await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });

          // 2. The automation, made on the box by its own CLI. Made early in
          // a minute on the box's clock, so its first occurrence comes after
          // the quit below (a run fired with the desktop still up would keep
          // the agent thinking, and the overlap rule would skip the rest).
          await pollFor(
            "the start of a minute on the box",
            () => {
              const s = new Date(boxNow()).getUTCSeconds();
              return s >= 1 && s <= 25 ? true : null;
            },
            70_000,
            1_000,
          );
          const created = boxManor(
            [
              "create-automation",
              `--name ${sq(AUTOMATION_NAME)}`,
              `--cron ${sq("* * * * *")}`,
              "--timezone UTC",
              `--prompt ${sq(PROMPT)}`,
              `--project-id ${sq(boxProject.id)}`,
              "--enabled",
            ].join(" "),
          ).stdout;
          console.log(`[automations-lid-closed] ${created}`);
          expect(created).toContain(`Created automation ${AUTOMATION_NAME}`);
          automationId = /\[([^\]]+)\]/.exec(created)?.[1] ?? null;
          expect(automationId, "the new automation's id").not.toBeNull();
          const id = automationId as string;

          // 3. The desktop quits, all the way: no window, no process, no ssh.
          const closed = await Promise.race([
            app.close().then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
          ]);
          if (!closed) {
            console.log("[automations-lid-closed] app.close() did not finish; killing the app");
          }
          await killApp(app);
          killAppSsh();
          await pollFor("no ssh of the app's left", () => (appSshAlive() ? null : true), 10_000);
          const quitAt = boxNow();
          console.log(`[automations-lid-closed] desktop quit at ${new Date(quitAt).toISOString()} (box clock)`);
          const runsText = () => boxManor(`list-automation-runs --id ${sq(id)}`).stdout;
          expect(parseRuns(runsText()), "no run fired before the desktop quit").toEqual([]);

          // 4. A run, fired with the desktop gone.
          let lastRuns = "";
          const run = await pollFor(
            "a started run fired after the quit",
            () => {
              lastRuns = runsText();
              return (
                parseRuns(lastRuns).find(
                  (r) => r.outcome === "started" && Date.parse(r.firedAt) >= quitAt,
                ) ?? null
              );
            },
            FIRE_WITHIN,
            2_000,
          ).catch((err: Error) => {
            throw new Error(`${err.message}\nruns on the box:\n${lastRuns || "(none)"}`);
          });
          console.log(`[automations-lid-closed] run: ${run.raw}`);
          expect(run.workspacePath, "the run's workspace").not.toBeNull();
          const runPath = run.workspacePath as string;

          // The run's Agent, made by the stub's first hook; read on the
          // phone, which reaches the box through the box's own pairing.
          const runAgent = await pollFor(
            "the run's agent on the phone",
            () =>
              page.evaluate(
                async ({ agentId, path }) => {
                  const agents = (await window.electronAPI.agents.getActive()) as {
                    id: string;
                    paneId: string | null;
                    workspacePath: string | null;
                  }[];
                  const a = agents.find(
                    (x) => (agentId !== null && x.id === agentId) || x.workspacePath === path,
                  );
                  return a?.paneId ? { id: a.id, paneId: a.paneId } : null;
                },
                { agentId: run.agentId, path: runPath },
              ),
            STEP,
            1_000,
          );

          // The project's Automations folder, with the run's workspace in it.
          const folder = folderHeader(page, "Automations").first();
          try {
            await expect(folder).toBeVisible({ timeout: 30_000 });
          } catch {
            // A collapsed project hides its folders: open it.
            await page
              .getByTestId("project-header")
              .filter({ hasText: PROJECT_NAME })
              .first()
              .click();
            await expect(folder).toBeVisible({ timeout: 30_000 });
          }
          if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
          await expect(folder).toHaveAttribute("aria-expanded", "true");
          const members = folder.locator("xpath=..").getByTestId("workspace-item");
          const runRow = members.filter({ hasText: /E2E nightly · / }).first();
          await expect(runRow).toBeVisible({ timeout: STEP });
          const runName = (await runRow.getByTestId("workspace-name").innerText()).trim();
          expect(runName).toMatch(RUN_NAME);
          await page.screenshot({ path: testInfo.outputPath("phone-automation-fired.png") });
          await testInfo.attach("phone-automation-fired.png", {
            path: testInfo.outputPath("phone-automation-fired.png"),
            contentType: "image/png",
          });

          // Its agent: the sidebar row takes the phone to the pane, which
          // shows the stub agent running.
          await runRow.click();
          const agentRow = page.locator(
            `[data-testid="sidebar-agent-row"][data-agent-id="${runAgent.id}"]`,
          );
          await expect(agentRow).toBeVisible({ timeout: STEP });
          await agentRow.click();
          const pane = page
            .locator(
              `[data-testid="workspace-pane"][data-pane-id="${runAgent.paneId}"] [data-testid="terminal-pane"]`,
            )
            .first();
          await expect(pane).toBeVisible({ timeout: 30_000 });
          await expect
            .poll(async () => stripAnsi(await paneText(page, runAgent.paneId).catch(() => "")), {
              timeout: STEP,
            })
            .toMatch(/manor-e2e-agent (started|working)/);
          const text = stripAnsi(await paneText(page, runAgent.paneId));
          if (!text.includes(PROMPT)) {
            console.log(`[automations-lid-closed] the prompt is not in the pane yet:\n${text}`);
          }
          await page.screenshot({ path: testInfo.outputPath("phone-automation-agent.png") });
          await testInfo.attach("phone-automation-agent.png", {
            path: testInfo.outputPath("phone-automation-agent.png"),
            contentType: "image/png",
          });

          // The bell, on the phone: the box's own log has "<name> ran" for a
          // run that fired with the desktop quit.
          // This web-app page is desk-sized, so the bell is the sidebar's button.
          await page.getByTestId("notifications-bell").click({ timeout: STEP });
          const ran = page
            .getByTestId("notification-row")
            .filter({ hasText: `${AUTOMATION_NAME} ran` })
            .first();
          await expect(ran).toBeVisible({ timeout: STEP });
          await page.screenshot({ path: testInfo.outputPath("phone-automation-bell.png") });
          await testInfo.attach("phone-automation-bell.png", {
            path: testInfo.outputPath("phone-automation-bell.png"),
            contentType: "image/png",
          });
          await page.keyboard.press("Escape");

          // The box's own record of it: its runs, and its host server's log.
          const finalRuns = runsText();
          const log = onRemote(
            'for f in "$HOME"/.manor/remote/server/logs/*.log; do [ -f "$f" ] || continue; ' +
              'echo "== $f"; grep -i "automation" "$f" | tail -n 80; done; true',
          ).stdout;
          const excerpt = `$ manor list-automation-runs --id ${id}\n${finalRuns}\n\n${log}`;
          console.log(`[automations-lid-closed] host log excerpt:\n${excerpt}`);
          await testInfo.attach("host-automation-log.txt", {
            body: excerpt,
            contentType: "text/plain",
          });

          // 5. Paused: it stops firing.
          const paused = boxManor(`pause-automation --id ${sq(id)}`).stdout;
          expect(paused).toContain(`Paused ${AUTOMATION_NAME}`);
        } catch (err) {
          console.log(`[automations-lid-closed.spec] phone log:\n${client.log.join("\n")}`);
          await client.page
            .screenshot({ path: testInfo.outputPath("phone.png") })
            .catch(() => {});
          throw err;
        } finally {
          await client.close();
        }
      } finally {
        if (automationId) {
          boxManor(`pause-automation --id ${sq(automationId)}`, { allowFailure: true });
          boxManor(`delete-automation --id ${sq(automationId)}`, { allowFailure: true });
        }
        closeForward();
      }
    },
  );
});
