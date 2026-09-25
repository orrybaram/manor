import fs from "fs";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, openTerminalTab, test } from "./fixtures";
import { readSession } from "./helpers/local-api";
import type { AgentSummary } from "./helpers/local-api";
import {
  APP_TARGET,
  REMOTE_AGENT,
  SEED_REPO_URL,
  installRemoteStubs,
  killAppSsh,
  onRemote,
  pollFor,
  remoteKind,
  remoteSkipReason,
  seedRemoteRepo,
  setAppTargetReachable,
} from "./helpers/remote-host";
import { setAgentCommand } from "./helpers/settings";
import { activePaneId, runInTerminal } from "./helpers/terminal";

/**
 * Remote projects end to end, against a real sshd (ADR-160 ticket 12,
 * ADR-178 ticket 8): a project cloned onto a box, a pane on it, and what the
 * app does when the connection goes away and comes back.
 *
 * - laptop closed: an agent finishes while the app cannot reach the box; the
 *   box journals the hooks, and on reconnect the sidebar shows the final
 *   status with exactly one notification.
 * - remote restart: the box's daemon restarts under a pane running an agent;
 *   the pane comes back with a fresh shell and the agent's resume command.
 * - ports: a dev server in a remote pane shows up in the port list, and
 *   opening it resolves to a local forward that serves it.
 *
 * Bootstrap, session lifecycle, journal replay and snapshot resync at the
 * bridge level are in electron/terminal-host/__tests__/remote-ssh.e2e.test.ts.
 *
 * Skipped unless MANOR_E2E_SSH=1. Run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only           # macOS sshd
 *   node scripts/test-remote-e2e.mjs --playwright-only --docker  # Linux box
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

/** A first connect to the Linux box compiles node-pty. */
const CONNECT_TIMEOUT = remoteKind() === "docker" ? 15 * 60_000 : 5 * 60_000;
const STEP = 60_000;
const PROJECT_NAME = "remote-e2e";
const REMOTE_DIR = `~/code/${PROJECT_NAME}`;

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // A clean slate on the box, keeping the installed host (a reinstall is
  // the bridge suite's job, and costs minutes on Linux): stop its daemon,
  // drop its journal, earlier runs' clones and the stubs, then set up again.
  onRemote(
    '[ -x "$HOME/.manor/bin/manor-host" ] && "$HOME/.manor/bin/manor-host" restart >/dev/null 2>&1; ' +
      'rm -rf "$HOME/.manor/remote" "$HOME/code" "$HOME/.manor-e2e"; true',
    { timeoutMs: STEP },
  );
  installRemoteStubs();
  seedRemoteRepo();
});

test.afterEach(() => {
  // A test that failed while the app's alias was blocked must not leave it so.
  setAppTargetReachable(true);
});

interface HostInfo {
  hostId: string;
  status: string;
  error?: string;
}

async function listHosts(window: Page): Promise<HostInfo[]> {
  return (await window.evaluate(() => window.electronAPI.hosts.list())) as HostInfo[];
}

async function hostStatus(window: Page, hostId: string): Promise<HostInfo | undefined> {
  return (await listHosts(window)).find((h) => h.hostId === hostId);
}

/**
 * Register the box, clone the seed repo onto it through the Add Project
 * dialog, and open a terminal tab in the project. Returns the host id and the
 * pane id, with the pane's (remote) shell at a prompt.
 */
async function openRemoteProject(
  window: Page,
  request: APIRequestContext,
  tempHome: string,
  { agentCommand }: { agentCommand?: string } = {},
): Promise<{ hostId: string; paneId: string }> {
  // Registering a host is Project Settings → Host in the UI; it has no
  // bearing on what this suite tests, so it goes straight through the API.
  const { hostId } = await window.evaluate(
    (target) => window.electronAPI.hosts.add(target),
    APP_TARGET,
  );
  await pollFor(
    `${APP_TARGET} connected`,
    async () => {
      const host = await hostStatus(window, hostId);
      if (host?.status === "error") throw new Error(`host failed: ${host.error}`);
      return host?.status === "connected" ? host : null;
    },
    CONNECT_TIMEOUT,
    500,
  );

  await window.getByTestId("import-project-button").click();
  const dialog = window.getByTestId("add-project-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText("On a remote host", { exact: true }).click();
  await dialog.locator("#add-project-host").click();
  await window.getByRole("option", { name: APP_TARGET, exact: true }).click();
  await dialog.locator("#add-project-repo-url").fill(SEED_REPO_URL);
  await dialog.locator("#add-project-remote-dir").fill(REMOTE_DIR);
  await dialog.locator("#add-project-name").fill(PROJECT_NAME);
  await dialog.getByRole("button", { name: "Clone", exact: true }).click();

  // Clone, then the host health check. Its results depend on what CLIs the
  // box has, which is not this test's business — only that it ran.
  await expect(dialog.getByTestId("health-check-list")).toBeVisible({ timeout: STEP });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  onRemote(`test -f ${REMOTE_DIR}/README.md`);

  // Before the pane exists: its agent context is read when it is created.
  if (agentCommand) await setAgentCommand(window, PROJECT_NAME, agentCommand);

  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitRemotePrompt(window, request, tempHome, paneId);
  return { hostId, paneId };
}

/**
 * Wait until the remote shell in `paneId` runs what is typed. Its scrollback
 * lives on the box, so it is read through the app's own control surface. A
 * line typed before the shell is ready is dropped, so this retypes; the
 * marker is computed by the shell, so the typed text never matches it.
 */
async function awaitRemotePrompt(
  window: Page,
  request: APIRequestContext,
  tempHome: string,
  paneId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await runInTerminal(window, "echo READY_$((20+22))");
    try {
      await pollFor(
        "the remote shell's prompt",
        async () =>
          (await readSession(request, tempHome, paneId)).includes("READY_42") ? true : null,
        5_000,
      );
      return;
    } catch {
      // Not ready yet; type it again.
    }
  }
  throw new Error(`remote shell in ${paneId} never answered`);
}

async function agentOnPane(
  request: APIRequestContext,
  tempHome: string,
  paneId: string,
): Promise<AgentSummary | undefined> {
  const port = Number(
    fs.readFileSync(path.join(tempHome, ".manor", "webview-server-port"), "utf-8").trim(),
  );
  const res = await request.get(`http://127.0.0.1:${port}/agents`);
  if (!res.ok()) return undefined;
  const agents = (await res.json()) as AgentSummary[];
  return agents.find((a) => a.paneId === paneId && a.status === "active");
}

/** Mirrors `notificationsFile()` in electron/paths.ts. */
function agentNotifications(tempHome: string, agentId: string): { kind: string }[] {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  const file = path.join(dataDir, "notifications.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      notifications?: { kind: string; target: { type: string; agentId?: string } | null }[];
    };
    return (parsed.notifications ?? []).filter(
      (n) => n.target?.type === "agent" && n.target.agentId === agentId,
    );
  } catch {
    return []; // Mid-write; the poll comes back.
  }
}

async function retryHost(window: Page, hostId: string): Promise<void> {
  await window.evaluate((id) => window.electronAPI.hosts.retryConnect(id), hostId);
}

test.describe("remote host", () => {
  test.setTimeout(CONNECT_TIMEOUT + 5 * STEP);

  test("laptop closed: hooks fired while away replay with one notification", async ({
    window,
    request,
    tempHome,
  }) => {
    const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
    const agentSession = `laptop-${Date.now()}`;

    await runInTerminal(window, `${REMOTE_AGENT} --session ${agentSession}`);
    const agent = await pollFor(
      "the remote agent thinking",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "thinking" ? a : null;
      },
      STEP,
    );
    const before = agentNotifications(tempHome, agent.id).length;

    // Lid closed: the box becomes unreachable and the live connection dies.
    setAppTargetReachable(false);
    killAppSsh();
    await pollFor(
      "the host to drop",
      async () => ((await hostStatus(window, hostId))?.status === "reconnecting" ? true : null),
      STEP,
    );
    await expect(window.getByTestId("host-offline-banner")).toBeVisible({ timeout: STEP });

    // The agent finishes, is prompted again, and finishes again — two
    // "responded" transitions nobody was connected to see.
    for (const event of ["Stop", "UserPromptSubmit", "Stop"]) {
      onRemote(`"$HOME/.manor-e2e/bin/fire-hook" ${paneId} ${event} ${agentSession}`);
    }
    expect((await agentOnPane(request, tempHome, paneId))?.lastAgentStatus).toBe("thinking");

    // Lid open.
    setAppTargetReachable(true);
    await retryHost(window, hostId);
    await pollFor(
      "the host back",
      async () => ((await hostStatus(window, hostId))?.status === "connected" ? true : null),
      2 * STEP,
    );

    await pollFor(
      "the replayed final status",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "responded" ? a : null;
      },
      STEP,
    );
    await expect(window.getByTestId("host-offline-banner")).not.toBeVisible({ timeout: STEP });

    // Coalesced: one notification for the whole absence, not one per hook.
    await expect
      .poll(() => agentNotifications(tempHome, agent.id).length - before, { timeout: STEP })
      .toBe(1);
    await window.waitForTimeout(2_000); // nothing late behind it
    const added = agentNotifications(tempHome, agent.id).slice(before);
    expect(added.map((n) => n.kind)).toEqual(["agent-responded"]);
  });

  test("remote restart: the pane comes back with the agent's resume command", async ({
    window,
    request,
    tempHome,
  }) => {
    const { paneId } = await openRemoteProject(window, request, tempHome, {
      agentCommand: REMOTE_AGENT,
    });
    const agentSession = `resume-${Date.now()}`;

    await runInTerminal(window, `${REMOTE_AGENT} --session ${agentSession}`);
    await pollFor(
      "the remote agent active",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "thinking" ? a : null;
      },
      STEP,
    );

    // The box's daemon restarts (a reboot, or `manor-host restart`): every
    // PTY on it is gone, the session with it.
    onRemote('"$HOME/.manor/bin/manor-host" restart');
    // The notice shows when recovery starts and auto-dismisses; watch for it
    // now rather than after the resume lands (slower on Linux).
    const notice = expect(
      window.getByText(/Remote host restarted — 1 session resumed/),
    ).toBeVisible({ timeout: 2 * STEP });

    // The pane is recovered on a fresh shell, and Manor types the resume
    // command the connector builds for the agent's session.
    await pollFor(
      "the stub agent resumed on the box",
      () =>
        onRemote('cat "$HOME/.manor-e2e/resumed.log" 2>/dev/null; true')
          .stdout.split("\n")
          .includes(agentSession)
          ? true
          : null,
      2 * STEP,
      500,
    );
    await notice;
    await expect
      .poll(() => readSession(request, tempHome, paneId), { timeout: STEP })
      .toContain(`manor-e2e-agent resumed ${agentSession}`);
  });

  test("ports: a remote dev server is listed and opens through a local forward", async ({
    window,
    request,
    tempHome,
  }) => {
    const { hostId } = await openRemoteProject(window, request, tempHome);
    const remotePort = 41_000 + Math.floor(Math.random() * 8_000);
    const body = `manor-e2e-served-${remotePort}`;

    await runInTerminal(
      window,
      `node -e "require('http').createServer((q,s)=>s.end('${body}')).listen(${remotePort},'127.0.0.1')"`,
    );

    type Port = { port: number; hostId?: string; hostname: string | null };
    const listed = await pollFor(
      `port ${remotePort} on the remote host`,
      async () => {
        const ports = (await window.evaluate(() => window.electronAPI.ports.scanNow())) as Port[];
        return ports.find((p) => p.port === remotePort && p.hostId === hostId);
      },
      STEP,
      1_000,
    );
    if (!listed.hostname) {
      await expect(
        window.getByRole("button", { name: `Open localhost:${remotePort}`, exact: true }),
      ).toBeVisible({ timeout: STEP });
    }

    // Opening it is what a port badge click does: main swaps in a forward.
    const resolved = await window.evaluate(
      ([url, id]) => window.electronAPI.ports.resolveUrl(url, id),
      [`http://localhost:${remotePort}/`, hostId] as const,
    );
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/$/.exec(resolved);
    expect(match, `resolved URL ${resolved}`).not.toBeNull();
    if (remoteKind() !== "docker") {
      // On the macOS sshd the box *is* this machine, so the remote port is
      // taken here and the forward must have picked another one.
      expect(Number(match![1])).not.toBe(remotePort);
    }
    const res = await request.get(resolved);
    expect(res.ok()).toBe(true);
    expect(await res.text()).toBe(body);
  });
});
