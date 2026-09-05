import { expect, type ElectronApplication, type Page } from "@playwright/test";

import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  createWorkspace,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_HUSH } from "./helpers/fake-agent";
import {
  layout,
  sendToSession,
  tabIdForPane,
  waitForAgentStatus,
  waitForVisibleSession,
} from "./helpers/local-api";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";

/**
 * Read state, end to end (issue #142).
 *
 * Clicking a row in the agent list marked its agent read. Arriving at the same
 * agent any other way — switching to its tab, switching back to its workspace
 * — did not, so main went on announcing a response the user was already
 * looking at: the dock badge stayed up and the tab, workspace and project dots
 * kept pulsing while the agent list itself had gone quiet.
 *
 * Nothing here fabricates the unread state. An agent reports a status over the
 * hook endpoint while its pane is off screen, and the app is then driven back
 * to it the way a person would.
 */

const AGENT_TITLE = "read-state-agent";

/**
 * The macOS dock badge — main's own read of its unseen Sets: "N" while N
 * sessions want input, "•" while one has only responded, empty when nothing is
 * unread. It is the user-visible witness for state the renderer only caches,
 * and the one the renderer cannot fake.
 */
function dockBadge(app: ElectronApplication): Promise<string> {
  return app.evaluate(
    ({ app: electronApp }) => electronApp.dock?.getBadge() ?? "",
  );
}

/** Start the fake agent in the pane on screen, and return that pane's id. */
async function startAgent(window: Page, tempHome: string): Promise<string> {
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
  return paneId;
}

/** Wait until `paneId` is off screen. Hidden tabs stay mounted, so this is not
 *  the same as waiting for it to leave the DOM. */
function expectPaneHidden(window: Page, paneId: string): Promise<void> {
  return expect(
    window.locator(
      `[data-testid="workspace-pane"][data-pane-id="${paneId}"]`,
    ),
  ).toBeHidden({ timeout: 30_000 });
}

/**
 * Open a fresh terminal tab and wait until `hiddenPaneId` is off screen.
 *
 * `openTerminalTab` cannot do this: its `terminal-pane` locator keeps matching
 * the agent's still-mounted pane — the first one in the DOM — so it waits for
 * a pane that will never be visible again.
 */
async function openTabAwayFrom(
  window: Page,
  hiddenPaneId: string,
): Promise<void> {
  await window.keyboard.press("Meta+t");
  await expectPaneHidden(window, hiddenPaneId);
  await assertVisiblePaneCount(window, 1);
}

test.describe("read state", () => {
  test.setTimeout(240_000);

  test("switching back to the agent's tab stops its tab dot pulsing", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "read-state");
    const agentPaneId = await startAgent(window, tempHome);
    const session = await waitForVisibleSession(request, tempHome, {
      name: AGENT_TITLE,
    });
    const agentTabId = await tabIdForPane(request, tempHome, agentPaneId);

    // Baseline: the agent has been on screen the whole time, so nothing is
    // unread — and nothing else in this temp home is contributing to the badge
    // either, which is what makes the assertions below about our session.
    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("");

    // Look away, then let the agent finish a turn without asking for anything
    // back: `responded` is the status the green dot pulses for.
    await openTabAwayFrom(window, agentPaneId);
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "responded");

    const dot = window.locator(
      `[data-testid="tab"][data-tab-id="${agentTabId}"] [data-testid="agent-dot"]`,
    );
    await expect(dot).toHaveAttribute("data-status", "responded", {
      timeout: 30_000,
    });
    await expect(dot).toHaveAttribute("data-pulse", "true");
    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("•");

    // Back to it the plain way, by clicking its tab.
    await window
      .locator(`[data-testid="tab"][data-tab-id="${agentTabId}"]`)
      .click();
    await expect(
      window.locator(
        `[data-testid="workspace-pane"][data-pane-id="${agentPaneId}"]`,
      ),
    ).toBeVisible();

    // Still responded — the response did not go anywhere — but no longer new.
    await expect(dot).toHaveAttribute("data-pulse", "false", {
      timeout: 30_000,
    });
    await expect(dot).toHaveAttribute("data-status", "responded");
    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("");
  });

  test("switching back to the agent's workspace stops its sidebar dot pulsing", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "read-state-a");
    const agentPaneId = await startAgent(window, tempHome);
    const session = await waitForVisibleSession(request, tempHome, {
      name: AGENT_TITLE,
    });
    const agentWorkspacePath = (await layout(request, tempHome)).workspacePath;

    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("");

    // A second workspace is a whole different layout — the agent's pane is not
    // just on a background tab, it is out of the active workspace entirely.
    await createWorkspace(window, "read-state-b");
    await expectPaneHidden(window, agentPaneId);

    await sendToSession(request, tempHome, session.id, FAKE_AGENT_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "responded");

    const workspaceItem = window.locator(
      `[data-testid="workspace-item"][data-workspace-path="${agentWorkspacePath}"]`,
    );
    const dot = workspaceItem.locator('[data-testid="agent-dot"]');
    await expect(dot).toHaveAttribute("data-status", "responded", {
      timeout: 30_000,
    });
    await expect(dot).toHaveAttribute("data-pulse", "true");
    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("•");

    await workspaceItem.click();
    await expect(
      window.locator(
        `[data-testid="workspace-pane"][data-pane-id="${agentPaneId}"]`,
      ),
    ).toBeVisible({ timeout: 30_000 });

    await expect(dot).toHaveAttribute("data-pulse", "false", {
      timeout: 30_000,
    });
    await expect.poll(() => dockBadge(app), { timeout: 30_000 }).toBe("");
  });
});
