import fs from "fs";
import path from "path";

import { expect, type Page } from "@playwright/test";

import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  APP_TARGET,
  GITHUB_SEED_URL,
  REMOTE_AGENT,
  installRemoteStubs,
  killAppSsh,
  onRemote,
  pointHostServerAtRelay,
  pollFor,
  remoteHome,
  remoteKind,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  setAppTargetReachable,
  setRemoteGhPrs,
} from "./helpers/remote-host";
import { CONNECT_TIMEOUT, STEP, hostStatus, retryHost } from "./helpers/remote-project";
import { closeSettings, pairHostPhone } from "./helpers/settings";

/**
 * The host owns its host (ADR-227), end to end.
 *
 * A desktop that predates ownership holds a remote project (a named main
 * workspace and worktree, a folder, a linked issue, a setup script) in its own
 * `projects.json`. Then:
 *
 * 1. **Adoption.** On connect the desktop hands the project to the box's host
 *    server, backs what it held up, and lets go: the box's `projects.json`
 *    has the lot, the desktop's has none of it, and the sidebar looks the
 *    same.
 * 2. **Lid closed.** The desktop's ssh is killed. A phone paired with the host
 *    server makes a worktree from the New agent composer (the box's setup
 *    script runs) and launches an agent in it with a prompt; the agent's
 *    status moves from thinking to working to requires-input.
 * 3. **Box CLI.** `manor list-workspaces` on the box, still with no desktop,
 *    lists the new worktree: the host server answers it.
 * 4. **Reconnect.** The desktop comes back and, with no restart, its sidebar
 *    has the workspace, the agent's tab and the agent's status.
 * 5. **GitHub.** The box's `gh` (a fake) reports a PR for the new branch, and
 *    its badge shows on the phone and on the desktop.
 *
 * Needs the private-sshd target (`node scripts/test-remote-e2e.mjs`): the
 * box must reach the test's local relay on 127.0.0.1, which a Docker
 * container cannot.
 */

const skipReason =
  remoteSkipReason() ??
  (remoteKind() === "docker"
    ? "the container cannot reach the local relay on the test machine's loopback"
    : null);

const HOST_ID = "adoption-e2e-host";
const PROJECT_ID = "adoption-e2e-project";
const PROJECT_NAME = "legacy-remote";
const MAIN_NAME = "Home base";
const LEGACY_NAME = "Legacy tree";
const FOLDER_NAME = "Backlog";
const ISSUE = {
  id: "issue-1",
  identifier: "E2E-1",
  title: "Legacy issue",
  url: "https://example.com/E2E-1",
};
const PROMPT = "fix the login bug";
const NEW_WORKSPACE = "fix-the-login-bug";

/** Where the desktop keeps `projects.json`, as `manorDataDir()` says. */
function desktopDataDir(home: string): string {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Manor")
    : path.join(home, ".local", "share", "Manor");
}

function readDesktopProjects(home: string): { projects: { id: string }[] } {
  return JSON.parse(fs.readFileSync(path.join(desktopDataDir(home), "projects.json"), "utf-8"));
}

interface BoxProject {
  id: string;
  name: string;
  path: string;
  workspaceNames?: Record<string, string>;
  workspaceFolders?: { id: string; name: string }[];
  workspaceFolderIds?: Record<string, string>;
  workspaceIssues?: Record<string, { identifier: string }[]>;
}

function readBoxProjects(): BoxProject[] {
  const raw = onRemote('cat "$HOME/.manor/remote/server/projects.json" 2>/dev/null; true').stdout;
  if (!raw.trim()) return [];
  return (JSON.parse(raw) as { projects: BoxProject[] }).projects;
}

const test = relayTest.extend({
  // The desktop is launched with the project already in its `projects.json`:
  // a desktop from before the flip, connecting to a box it has not yet handed
  // anything to. The host server starts on that first connect, against this
  // test's relay.
  tempHome: async ({ tempHome, relay }, use) => {
    pointHostServerAtRelay(relay.url);
    const boxHome = remoteHome();
    const main = `${boxHome}/code/${PROJECT_NAME}`;
    const legacy = `${boxHome}/code/${PROJECT_NAME}-worktrees/legacy`;
    onRemote(
      [
        "set -e",
        `git clone -q ${GITHUB_SEED_URL} "${main}"`,
        `git -C "${main}" worktree add -q -b legacy "${legacy}" origin/main`,
      ].join("; "),
      { timeoutMs: 60_000 },
    );
    const dataDir = desktopDataDir(tempHome);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "projects.json"),
      JSON.stringify({
        projects: [
          {
            id: PROJECT_ID,
            name: PROJECT_NAME,
            path: main,
            selectedWorkspaceIndex: 0,
            workspaces: [],
            defaultBranch: "main",
            defaultRunCommand: null,
            worktreePath: `${boxHome}/code/${PROJECT_NAME}-worktrees`,
            worktreeStartScript: "touch .setup-ran",
            agentCommand: REMOTE_AGENT,
            setupComplete: true,
            hostId: HOST_ID,
            workspaceNames: { [main]: MAIN_NAME, [legacy]: LEGACY_NAME },
            workspaceFolders: [{ id: "folder-1", name: FOLDER_NAME, parentId: null }],
            workspaceFolderIds: { [legacy]: "folder-1" },
            workspaceIssues: { [legacy]: [ISSUE] },
          },
        ],
        selectedProjectIndex: 0,
        hosts: { [HOST_ID]: { spec: { kind: "ssh", target: APP_TARGET } } },
      }),
    );
    await use(tempHome);
  },
});

test.skip(skipReason !== null, skipReason ?? "");
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

test.afterEach(() => {
  setAppTargetReachable(true);
});

/** The sidebar's workspace rows that mention `text`. */
function sidebarRow(page: Page, text: string | RegExp) {
  return page.getByTestId("workspace-item").filter({ hasText: text });
}

/** Every active agent, as `page` sees it. */
function activeAgents(page: Page) {
  return page.evaluate(
    async () =>
      (await window.electronAPI.agents.getActive()) as {
        paneId: string | null;
        agentSessionId: string;
        lastAgentStatus: string | null;
        workspacePath: string | null;
      }[],
  );
}

test.describe("the host owns its host", () => {
  test.setTimeout(CONNECT_TIMEOUT + 12 * STEP);

  test("adoption, then a phone makes a worktree and launches an agent with the lid closed", async ({
    window,
    tempHome,
  }) => {
    // 1. Adoption: an awaited step, not a side effect of the first connect.
    await pollFor(
      "the host connected",
      async () => {
        const host = await hostStatus(window, HOST_ID);
        if (host?.status === "error") throw new Error(`host failed: ${host.error}`);
        return host?.status === "connected" ? host : null;
      },
      CONNECT_TIMEOUT,
      500,
    );
    const backup = path.join(tempHome, ".manor", "backups", `pre-adr-227-${HOST_ID}.json`);
    await pollFor("the adoption backup", () => (fs.existsSync(backup) ? true : null), STEP);

    const main = `${remoteHome()}/code/${PROJECT_NAME}`;
    const legacy = `${main}-worktrees/legacy`;
    const boxProject = await pollFor(
      "the project on the box",
      () => readBoxProjects().find((p) => p.name === PROJECT_NAME) ?? null,
      STEP,
    );
    expect(boxProject.path).toBe(main);
    expect(boxProject.workspaceNames).toMatchObject({ [main]: MAIN_NAME, [legacy]: LEGACY_NAME });
    expect(boxProject.workspaceFolders?.map((f) => f.name)).toEqual([FOLDER_NAME]);
    expect(boxProject.workspaceFolderIds).toMatchObject({ [legacy]: "folder-1" });
    expect(boxProject.workspaceIssues?.[legacy]?.map((i) => i.identifier)).toEqual([
      ISSUE.identifier,
    ]);
    const ownership = JSON.parse(
      onRemote('cat "$HOME/.manor/remote/server/ownership.json"').stdout,
    ) as { ownership?: string };
    expect(JSON.stringify(ownership)).toContain("host");

    // The desktop let go of it, and kept a copy.
    await expect
      .poll(() => readDesktopProjects(tempHome).projects.map((p) => p.id), { timeout: STEP })
      .toEqual([]);
    expect(JSON.parse(fs.readFileSync(backup, "utf-8"))).toBeTruthy();

    // The sidebar is as it was: the project, its named workspaces, the folder.
    await expect(sidebarRow(window, MAIN_NAME)).toBeVisible({ timeout: STEP });
    await expect(sidebarRow(window, LEGACY_NAME)).toBeVisible();
    await expect(window.getByText(FOLDER_NAME, { exact: true })).toBeVisible();

    // 2. Lid closed.
    const device = await pairHostPhone(window, { hostName: APP_TARGET, label: "owned phone" });
    await closeSettings(window);
    setAppTargetReachable(false);
    killAppSsh();
    await pollFor(
      "the host to drop",
      async () => ((await hostStatus(window, HOST_ID))?.status === "reconnecting" ? true : null),
      STEP,
    );

    const client = await openWebApp(device.link, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });
    try {
      const page = client.page;
      await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 60_000 });

      // The phone sees the adopted project, and its workspaces by their names.
      const named = await page.evaluate(async () => {
        const projects = (await window.electronAPI.projects.getAll()) as {
          name: string;
          workspaces: { name: string | null }[];
        }[];
        return projects.map((p) => [p.name, p.workspaces.map((w) => w.name).sort()]);
      });
      expect(named).toEqual([[PROJECT_NAME, [LEGACY_NAME, MAIN_NAME].sort()]]);

      // A worktree and an agent with a prompt, from the New agent composer.
      await page.getByTestId("phone-drawer-toggle").tap();
      await page.getByTestId("drawer-new-agent").tap();
      await expect(page.getByTestId("phone-empty-composer-input")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("phone-target-worktree").tap();
      await expect(page.getByTestId("phone-target-worktree")).toBeChecked();
      await page.getByTestId("phone-empty-composer-input").fill(PROMPT);
      await page.getByTestId("phone-empty-send").tap();

      // The box's git made the worktree, and its setup script ran in it.
      const workspace = `${main}-worktrees/${NEW_WORKSPACE}`;
      await pollFor(
        "the new worktree and its setup script on the box",
        () =>
          onRemote(`test -f "${workspace}/.setup-ran"`, { allowFailure: true }).code === 0
            ? true
            : null,
        STEP,
      );

      // The agent: started on the box by its own server, with the prompt.
      const agentOnPhone = async () =>
        (await activeAgents(page)).find((a) => a.workspacePath === workspace);
      const agent = await pollFor("the agent on the phone", agentOnPhone, STEP);
      expect(agent.paneId).toBeTruthy();
      await pollFor(
        "the agent thinking",
        async () => ((await agentOnPhone())?.lastAgentStatus === "thinking" ? true : null),
        STEP,
      );
      const fire = (event: string) =>
        onRemote(
          `"$HOME/.manor-e2e/bin/fire-hook" ${agent.paneId} ${event} ${agent.agentSessionId}`,
        );
      fire("PreToolUse");
      await pollFor(
        "the agent working",
        async () => ((await agentOnPhone())?.lastAgentStatus === "working" ? true : null),
        STEP,
      );
      fire("Notification");
      await pollFor(
        "the agent waiting for input",
        async () => ((await agentOnPhone())?.lastAgentStatus === "requires_input" ? true : null),
        STEP,
      );

      // 3. The box's own CLI, with no desktop anywhere: the host server
      // answers it.
      const listed = onRemote(
        `cd "${main}" && MANOR_CONTROL_PORT_FILE="$HOME/.manor/remote/control-port" ` +
          '"$HOME/.manor/bin/manor" list-workspaces',
        { timeoutMs: 60_000 },
      );
      expect(listed.stdout).toContain(workspace);

      // 5 (phone half). GitHub reports a PR for the new branch.
      const pr = {
        number: 7,
        state: "OPEN",
        title: "Fix the login bug",
        url: "https://github.com/manor-e2e/seed/pull/7",
        isDraft: false,
        additions: 1,
        deletions: 0,
        reviewDecision: null,
        updatedAt: new Date().toISOString(),
        autoMergeRequest: null,
        statusCheckRollup: [],
      };
      setRemoteGhPrs({ prs: { [NEW_WORKSPACE]: pr } });
      // The phone has no workspace list; its tab menu offers the PR's link.
      await expect
        .poll(
          async () => {
            await page.getByTestId("tab").first().click({ button: "right" });
            const offered = await page
              .getByTestId("phone-tab-copy-pr")
              .isVisible()
              .catch(() => false);
            await page.keyboard.press("Escape");
            return offered;
          },
          { timeout: 2 * STEP, intervals: [3_000] },
        )
        .toBe(true);

      // 4. Lid open: the desktop reconnects, and without a restart the
      // workspace, its agent tab and the agent are in its sidebar.
      setAppTargetReachable(true);
      await retryHost(window, HOST_ID);
      await pollFor(
        "the host back",
        async () => ((await hostStatus(window, HOST_ID))?.status === "connected" ? true : null),
        2 * STEP,
      );
      await expect(sidebarRow(window, NEW_WORKSPACE)).toBeVisible({ timeout: STEP });
      const desktopAgent = await pollFor(
        "the agent on the desktop",
        async () => {
          const a = (await activeAgents(window)).find((x) => x.workspacePath === workspace);
          return a?.lastAgentStatus === "requires_input" ? a : null;
        },
        STEP,
      );
      expect(desktopAgent.paneId).toBe(agent.paneId);
      await sidebarRow(window, NEW_WORKSPACE).click();
      await expect(
        window.locator(`[data-testid="workspace-pane"][data-pane-id="${agent.paneId}"]`).first(),
      ).toBeAttached({ timeout: STEP });

      // 5 (desktop half).
      await expect(sidebarRow(window, NEW_WORKSPACE).locator("[data-readiness]")).toBeVisible({
        timeout: 2 * STEP,
      });
    } catch (err) {
      console.log(`[host-ownership.spec] phone log:\n${client.log.join("\n")}`);
      throw err;
    } finally {
      await client.close();
    }
  });
});
