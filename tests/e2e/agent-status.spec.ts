import { expect, type Page } from "@playwright/test";

import { bootWorkspaceWithTerminal, test } from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_EXIT, FAKE_AGENT_SLOW_HUSH } from "./helpers/fake-agent";
import {
  sendToSession,
  waitForAgentStatus,
  waitForVisibleSession,
} from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The dot and its tooltip, end to end (ADR-184).
 *
 * One Status reconciler in Electron main decides every pane's Agent status
 * from Status signals — here, the fake agent's own hook calls — and the
 * renderer only displays what it publishes: a `{ status, reason }` per pane.
 * These specs drive a real turn and a real exit through that hook protocol
 * and check what lands on the sidebar's dot, not a UI-side re-derivation of
 * either.
 */

const AGENT_TITLE = "agent-status-agent";

/** Start the fake agent in the pane on screen, and return that pane's id. */
async function startAgent(window: Page, tempHome: string): Promise<string> {
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
  return paneId;
}

test.describe("agent status", () => {
  test.setTimeout(120_000);

  test("a turn shows thinking with its reason, then responded", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "agent-status-turn");
    await startAgent(window, tempHome);
    const session = await waitForVisibleSession(request, tempHome, {
      name: AGENT_TITLE,
    });

    const row = window.locator(
      `[data-testid="sidebar-agent-row"][data-agent-id="${session.id}"]`,
    );
    await expect(row).toBeVisible({ timeout: 10_000 });

    // "slow-hush" holds `thinking` (the UserPromptSubmit hook) for a second
    // before its Stop hook parks the turn in `responded` — long enough to
    // observe both in turn, and both reasons as the dot's tooltip.
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_SLOW_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "thinking");

    // Working/thinking has no `data-status` dot (see AgentDot) — its spinner
    // carries the reason as a tooltip instead.
    const spinner = row.locator('[title="Agent thinking"]');
    await expect(spinner).toBeVisible({ timeout: 5_000 });
    await spinner.hover();
    await expect(window.getByText("UserPromptSubmit hook")).toBeVisible({
      timeout: 5_000,
    });

    const dot = row.locator('[data-testid="agent-dot"]');
    await expect(dot).toHaveAttribute("data-status", "responded", {
      timeout: 10_000,
    });
    await dot.hover();
    await expect(window.getByText("Stop hook")).toBeVisible({ timeout: 5_000 });
  });

  test("agent exit parks the pane in idle and the agent completed", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "agent-status-exit");
    await startAgent(window, tempHome);
    const session = await waitForVisibleSession(request, tempHome, {
      name: AGENT_TITLE,
    });

    // "exit" ends the session the way a real agent CLI would when the user
    // quits it: a SessionEnd hook, then the process exits.
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_EXIT);
    await waitForAgentStatus(request, tempHome, session.id, "idle");

    const row = window.locator(
      `[data-testid="sidebar-agent-row"][data-agent-id="${session.id}"]`,
    );
    // `idle` renders no dot at all (AgentDot returns null for it) — the
    // agent's lifecycle badge takes its place once it is `completed`.
    await expect(row.locator('[data-testid="agent-dot"]')).toHaveCount(0);
    const badge = row.locator('[data-testid="agent-lifecycle-badge"]');
    await expect(badge).toHaveAttribute("data-lifecycle", "completed", {
      timeout: 10_000,
    });
  });
});
