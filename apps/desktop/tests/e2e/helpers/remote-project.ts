import type { APIRequestContext, Page } from "@playwright/test";

import { expect, openTerminalTab } from "../fixtures";
import { localApiHeaders, localApiUrl, readSession, type AgentSummary } from "./local-api";
import {
  APP_TARGET,
  onRemote,
  pollFor,
  remoteKind,
  SEED_REPO_URL,
} from "./remote-host";
import { setAgentCommand } from "./settings";
import { runInTerminal, activePaneId } from "./terminal";

/**
 * A project on the remote-host suite's box, set up through the app the way a
 * user does it: register the host, clone the seed repo
 * onto it, open a terminal on it. Shared by `remote-host.spec.ts` and
 * `host-server.spec.ts`; the box itself is `./remote-host.ts`.
 */

/** A first connect to the Linux box compiles node-pty. */
export const CONNECT_TIMEOUT =
  remoteKind() === "docker" ? 15 * 60_000 : 5 * 60_000;
export const STEP = 60_000;
export const PROJECT_NAME = "remote-e2e";
const REMOTE_DIR = `~/code/${PROJECT_NAME}`;

interface HostInfo {
  hostId: string;
  status: string;
  error?: string;
}

async function listHosts(window: Page): Promise<HostInfo[]> {
  return (await window.evaluate(() =>
    window.electronAPI.hosts.list(),
  )) as HostInfo[];
}

export async function hostStatus(
  window: Page,
  hostId: string,
): Promise<HostInfo | undefined> {
  return (await listHosts(window)).find((h) => h.hostId === hostId);
}

export async function retryHost(window: Page, hostId: string): Promise<void> {
  await window.evaluate(
    (id) => window.electronAPI.hosts.retryConnect(id),
    hostId,
  );
}

/**
 * Register the box, clone the seed repo onto it through the Add Project
 * dialog, and open a terminal tab in the project. Returns the host id and the
 * pane id, with the pane's (remote) shell at a prompt.
 */
export async function openRemoteProject(
  window: Page,
  request: APIRequestContext,
  tempHome: string,
  {
    agentCommand,
    host,
  }: {
    agentCommand?: string;
    /** An already-registered host (a recipe host) to use instead of the ssh box. */
    host?: { hostId: string; hostLabel: string };
  } = {},
): Promise<{ hostId: string; paneId: string }> {
  // Registering a host is Project Settings → Host in the UI; it has no
  // bearing on what this suite tests, so it goes straight through the API.
  const hostLabel = host?.hostLabel ?? APP_TARGET;
  const hostId =
    host?.hostId ??
    (
      await window.evaluate(
        (target) => window.electronAPI.hosts.add(target),
        APP_TARGET,
      )
    ).hostId;
  await pollFor(
    `${hostLabel} connected`,
    async () => {
      const host = await hostStatus(window, hostId);
      if (host?.status === "error")
        throw new Error(`host failed: ${host.error}`);
      return host?.status === "connected" ? host : null;
    },
    CONNECT_TIMEOUT,
    500,
  );

  // The onboarding screen's clone row opens the Add Project dialog
  // already on its clone tab.
  await window.getByTestId("add-remote-project-button").click();
  const dialog = window.getByTestId("add-project-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator("#add-project-host").click();
  await window.getByRole("option", { name: hostLabel, exact: true }).click();
  await dialog.locator("#add-project-repo-url").fill(SEED_REPO_URL);
  await dialog.locator("#add-project-location").fill(REMOTE_DIR);
  await dialog.locator("#add-project-name").fill(PROJECT_NAME);
  await dialog.getByRole("button", { name: "Clone", exact: true }).click();

  // Clone, then the host health check. Its results depend on what CLIs the
  // box has, which is not this test's business — only that it ran.
  await expect(dialog.getByTestId("health-check-list")).toBeVisible({
    timeout: STEP,
  });
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
export async function awaitRemotePrompt(
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
          (await readSession(request, tempHome, paneId)).includes("READY_42")
            ? true
            : null,
        5_000,
      );
      return;
    } catch {
      // Not ready yet; type it again.
    }
  }
  throw new Error(`remote shell in ${paneId} never answered`);
}

/** The desktop's active agent on `paneId`, read off its local API. */
export async function agentOnPane(
  request: APIRequestContext,
  tempHome: string,
  paneId: string,
): Promise<AgentSummary | undefined> {
  const res = await request.get(localApiUrl(tempHome, "/agents"), {
    headers: localApiHeaders(tempHome),
  });
  if (!res.ok()) return undefined;
  const agents = (await res.json()) as AgentSummary[];
  return agents.find((a) => a.paneId === paneId && a.status === "active");
}
