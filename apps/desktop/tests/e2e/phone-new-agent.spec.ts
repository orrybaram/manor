import { expect, type ElectronApplication, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, openTerminalTab } from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_BANNER } from "./helpers/fake-agent";
import { openWebApp, type Client } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser, setAgentCommand } from "./helpers/settings";
import { activePaneId, awaitShellReady } from "./helpers/terminal";

/**
 * The phone's "New agent" composer end to end: it picks where an agent
 * runs (project, workspace, or a new worktree) and starts it only on send.
 *
 * Same discipline as `phone.spec.ts`: the desk is set up through its own UI,
 * the phone is an ordinary 390x844 touch page that knows only its pairing
 * link, and nothing reaches into the app to fabricate state. The project's
 * agent command is the fake agent (set through Settings), which prints the
 * prompt it was started with, so what the agent saw is what is asserted.
 */

const PROJECT_NAME = "test-project";
const WORKSPACE_A = "newagent-a";
const WORKSPACE_B = "newagent-b";

/** A pane's grid as text, read off its live `Terminal` (xterm draws to a canvas). */
function paneText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    return handle ? handle.serialize({ scrollback: 20_000 }) : "";
  }, paneId);
}

/**
 * Desk: the fake agent as the project's agent command, workspace A with a
 * terminal tab (the "agent tab" the phone starts on) and workspace B. Then
 * back to A, pair a phone and open it there. Returns the phone and A's pane.
 */
async function openPhone(fixtures: {
  app: ElectronApplication;
  window: Page;
  tempHome: string;
}): Promise<{ client: Client; page: Page; paneA: string }> {
  const { app, window, tempHome } = fixtures;
  await importSeededProject(app, window, tempHome);
  // Before any workspace exists: pane commands are read when it is created.
  await setAgentCommand(window, PROJECT_NAME, `"${FAKE_AGENT}"`);

  await createWorkspace(window, WORKSPACE_B);
  await createWorkspace(window, WORKSPACE_A);
  await openTerminalTab(window);
  const paneA = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneA);

  const device = await pairBrowser(window, { label: "new agent phone" });
  await closeSettings(window);
  const client = await openWebApp(device.link, {
    viewport: { width: 390, height: 844 },
    context: { isMobile: true, hasTouch: true },
  });
  const page = client.page;
  await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneA);
  return { client, page, paneA };
}

/** Drawer -> "New agent". */
async function openComposer(page: Page): Promise<void> {
  await page.getByTestId("phone-drawer-toggle").tap();
  await page.getByTestId("drawer-new-agent").tap();
  await expect(page.getByTestId("phone-empty-composer-input")).toBeVisible({ timeout: 15_000 });
}

/** Open a chip's choices and pick the row whose text matches. */
async function pickChoice(page: Page, chip: string, match: string | RegExp): Promise<void> {
  await page.getByTestId(chip).tap();
  const choices = page.getByTestId("phone-target-choices");
  await expect(choices).toBeVisible();
  await choices.getByTestId("phone-target-choice").filter({ hasText: match }).first().tap();
  await expect(choices).toHaveCount(0);
}

test.describe("phone new agent target picker", () => {
  test.setTimeout(240_000);

  test("New agent opens a composer that starts nothing, has no host chip for an unlinked project, and closes back to the tab", async ({
    app,
    window,
    tempHome,
  }) => {
    const { client, page, paneA } = await openPhone({ app, window, tempHome });
    try {
      const tabs = page.locator('[data-testid="tab"]');
      const tabsBefore = await tabs.count();
      const panesBefore = await page.locator('[data-testid="workspace-pane"]').count();

      await openComposer(page);
      await expect(page.getByTestId("phone-target-chips")).toBeVisible();
      await expect(page.getByTestId("phone-target-project")).toBeVisible();
      // A project linked to no other host offers no host choice.
      await expect(page.getByTestId("phone-target-host")).toHaveCount(0);
      // The composer seeds from the active workspace.
      await expect(page.getByTestId("phone-composer-subline")).toContainText(WORKSPACE_A);

      // Opening it created no tab and no pane.
      expect(await tabs.count()).toBe(tabsBefore);
      expect(await page.locator('[data-testid="workspace-pane"]').count()).toBe(panesBefore);

      await page.getByTestId("phone-composer-close").tap();
      await expect(page.getByTestId("phone-empty-composer-input")).toHaveCount(0);
      await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneA);
      expect(await tabs.count()).toBe(tabsBefore);
    } finally {
      await client.close();
    }
  });

  test("picking another workspace and sending starts the agent there with the prompt", async ({
    app,
    window,
    tempHome,
  }) => {
    const { client, page, paneA } = await openPhone({ app, window, tempHome });
    try {
      const prompt = "summarize the readme";
      await openComposer(page);
      await pickChoice(page, "phone-target-workspace", WORKSPACE_B);
      await expect(page.getByTestId("phone-composer-subline")).toContainText(WORKSPACE_B);

      await page.getByTestId("phone-empty-composer-input").fill(prompt);
      await page.getByTestId("phone-empty-send").tap();

      // The composer closes onto a new agent pane, in the other workspace.
      await expect(page.getByTestId("phone-empty-composer-input")).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect
        .poll(() => activePaneId(page), { timeout: 30_000 })
        .not.toBe(paneA);
      const newPane = await activePaneId(page);
      await expect
        .poll(() => paneText(page, newPane), { timeout: 30_000 })
        .toContain(FAKE_AGENT_BANNER);
      await expect
        .poll(() => paneText(page, newPane), { timeout: 15_000 })
        .toContain(prompt);
      // The phone moved to workspace B: it is the one its top bar names.
      await expect(page.getByTestId("phone-top-bar")).toContainText(WORKSPACE_B);
    } finally {
      await client.close();
    }
  });

  test("ticking worktree on main and sending makes a prompt-named workspace and starts the agent in it", async ({
    app,
    window,
    tempHome,
  }) => {
    const { client, page, paneA } = await openPhone({ app, window, tempHome });
    try {
      const prompt = "fix the login bug";
      await openComposer(page);
      await pickChoice(page, "phone-target-workspace", /main/);

      await page.getByTestId("phone-target-worktree").tap();
      await expect(page.getByTestId("phone-target-worktree")).toBeChecked();
      // Main's worktree bases off the project's default branch, the one the
      // send passes to creation.
      await expect(page.getByTestId("phone-composer-subline")).toContainText(
        "new worktree off main",
      );

      await page.getByTestId("phone-empty-composer-input").fill(prompt);
      await page.getByTestId("phone-empty-send").tap();

      // The workspace named after the prompt (or a suffixed variant) appears
      // on the desk, and the agent starts in a pane of its own.
      await expect(
        window.getByTestId("workspace-item").filter({ hasText: /fix-the-login-bug/ }),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(() => activePaneId(page), { timeout: 60_000 })
        .not.toBe(paneA);
      const newPane = await activePaneId(page);
      await expect
        .poll(() => paneText(page, newPane), { timeout: 60_000 })
        .toContain(prompt);
    } finally {
      await client.close();
    }
  });
});
