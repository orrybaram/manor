import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import {
  bootWorkspaceWithTerminal,
  expect,
  killApp,
  launchApp,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_HUSH } from "./helpers/fake-agent";
import {
  sendToSession,
  tabIdForPane,
  waitForAgentStatus,
  waitForVisibleSession,
} from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Renaming an agent by hand.
 *
 * An agent is normally named from its terminal title, and that sync runs on
 * every status change. The feature under test is a name the user typed that
 * *sticks*: it shows in the sidebar and on the tab, main persists it with a
 * pin so the next title sync leaves it alone, and clearing it hands naming
 * back to the terminal.
 *
 * The agent is the fake agent from the remote-control harness: it sets its
 * window title once at startup — which is what the auto-name comes from — and
 * every message it is sent moves its status, which is what makes the title
 * sync fire again.
 */

/** What the fake agent titles itself, and so what Manor auto-names it. */
const AGENT_TITLE = "rename-agent";

/** Where main persists agents — mirrors `agentsFile()` in paths.ts. */
function agentsFile(tempHome: string): string {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  return path.join(dataDir, "agents.json");
}

type PersistedAgent = { id: string; name: string | null; namePinned?: boolean };

/** The persisted record for `agentId`, or null while main has not written it. */
function persistedAgent(tempHome: string, agentId: string): PersistedAgent | null {
  const file = agentsFile(tempHome);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      agents?: PersistedAgent[];
    };
    return (parsed.agents ?? []).find((a) => a.id === agentId) ?? null;
  } catch {
    return null;
  }
}

/** The persisted `{ name, namePinned }` pair, as something `toEqual` can read. */
function persistedName(
  tempHome: string,
  agentId: string,
): { name: string | null; namePinned: boolean } | null {
  const agent = persistedAgent(tempHome, agentId);
  if (!agent) return null;
  return { name: agent.name, namePinned: agent.namePinned === true };
}

const sidebarRow = (window: Page, agentId: string) =>
  window.locator(`[data-testid="sidebar-agent-row"][data-agent-id="${agentId}"]`);
const modalRow = (window: Page, agentId: string) =>
  window.locator(`[data-testid="agents-modal-row"][data-agent-id="${agentId}"]`);
const nameIn = (row: ReturnType<Page["locator"]>) =>
  row.getByTestId("agent-name");
const inputIn = (row: ReturnType<Page["locator"]>) =>
  row.getByTestId("agent-name-input");
const tabTitle = (window: Page, tabId: string) =>
  window.locator(`[data-testid="tab"][data-tab-id="${tabId}"] [data-testid="tab-title"]`);

/**
 * Start the fake agent in the focused pane and wait until Manor has both a
 * session for it and the auto-synced name from its title.
 */
async function startNamedAgent(
  window: Page,
  tempHome: string,
  request: Parameters<typeof waitForVisibleSession>[0],
) {
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
  const session = await waitForVisibleSession(request, tempHome, {
    name: AGENT_TITLE,
  });
  return { paneId, session };
}

/** Double-click a row into edit mode, type a name, and commit it with Enter. */
async function renameThrough(
  row: ReturnType<Page["locator"]>,
  name: string,
): Promise<void> {
  await nameIn(row).dblclick();
  const input = inputIn(row);
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(name);
  await input.press("Enter");
  await expect(input).toHaveCount(0, { timeout: 5_000 });
}

test.describe("agent rename", () => {
  test.setTimeout(240_000);

  test("a name typed in the sidebar pins across the tab bar, main, and the title sync", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "rename-ws");
    const { paneId, session } = await startNamedAgent(window, tempHome, request);
    const tabId = await tabIdForPane(request, tempHome, paneId);

    // Baseline: the terminal title names the sidebar row. The tab has its own
    // idea of a title (the shell's, the cwd, or the terminal title once it
    // lands); whatever it is, the pin has to override it and clearing the
    // pin has to hand it back.
    const row = sidebarRow(window, session.id);
    await expect(nameIn(row)).toHaveText(AGENT_TITLE, { timeout: 30_000 });
    await expect(tabTitle(window, tabId)).not.toBeEmpty();
    await expect(tabTitle(window, tabId)).not.toHaveText("Fix login");
    await expect
      .poll(() => persistedName(tempHome, session.id), { timeout: 15_000 })
      .toEqual({ name: AGENT_TITLE, namePinned: false });

    // Escape abandons an edit without touching the name.
    await nameIn(row).dblclick();
    await expect(inputIn(row)).toBeVisible({ timeout: 5_000 });
    await expect(inputIn(row)).toHaveValue(AGENT_TITLE);
    await inputIn(row).fill("not this one");
    await inputIn(row).press("Escape");
    await expect(inputIn(row)).toHaveCount(0);
    await expect(nameIn(row)).toHaveText(AGENT_TITLE);

    // Enter commits: the sidebar, the tab, and the persisted record agree.
    await renameThrough(row, "Fix login");
    await expect(nameIn(row)).toHaveText("Fix login");
    await expect(tabTitle(window, tabId)).toHaveText("Fix login");
    await expect
      .poll(() => persistedName(tempHome, session.id), { timeout: 15_000 })
      .toEqual({ name: "Fix login", namePinned: true });

    // The whole point: a status change re-runs the title sync, which would
    // otherwise put the terminal title back. The pin has to hold.
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "responded");
    await expect(nameIn(row)).toHaveText("Fix login");
    await expect(tabTitle(window, tabId)).toHaveText("Fix login");
    expect(persistedName(tempHome, session.id)).toEqual({
      name: "Fix login",
      namePinned: true,
    });

    // Clearing the name unpins it, and the terminal title takes over again —
    // immediately, from the title the agent last reported, not after the next
    // status change.
    await renameThrough(row, "");
    await expect(nameIn(row)).toHaveText(AGENT_TITLE, { timeout: 10_000 });
    await expect(tabTitle(window, tabId)).not.toHaveText("Fix login");
    await expect
      .poll(() => persistedName(tempHome, session.id), { timeout: 15_000 })
      .toEqual({ name: AGENT_TITLE, namePinned: false });
  });

  test("the Agents modal renames through its context menu and the sidebar follows", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "agent-rename-modal");
    const { session } = await startNamedAgent(window, tempHome, request);

    const row = sidebarRow(window, session.id);
    await expect(nameIn(row)).toHaveText(AGENT_TITLE, { timeout: 30_000 });

    await window.getByTestId("sidebar-agents-view-all").click();
    const modal = window.getByTestId("agents-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const inModal = modalRow(window, session.id);
    await expect(nameIn(inModal)).toHaveText(AGENT_TITLE, { timeout: 10_000 });

    // Right-click → Rename Agent is the discoverable path; double-click is
    // the shortcut. Both land in the same inline editor.
    await nameIn(inModal).click({ button: "right" });
    await window.getByRole("menuitem", { name: "Rename Agent" }).click();
    const input = inputIn(inModal);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveValue(AGENT_TITLE);
    await input.fill("Renamed in modal");
    await input.press("Enter");
    await expect(input).toHaveCount(0, { timeout: 5_000 });

    await expect(nameIn(inModal)).toHaveText("Renamed in modal");
    // Same store, same broadcast: the sidebar row behind the modal updates too.
    await expect(nameIn(row)).toHaveText("Renamed in modal");
    await expect
      .poll(() => persistedName(tempHome, session.id), { timeout: 15_000 })
      .toEqual({ name: "Renamed in modal", namePinned: true });

    // Renaming did not count as a click: the modal is still open and the
    // agent was not resumed into a second pane.
    await expect(modal).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
    await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(1);
  });

  /**
   * Launches its own app instances rather than taking the fixture's: the
   * fixture owns the shutdown of the app it created, and killing that one
   * mid-test leaves its teardown holding a disposed handle.
   */
  test("a pinned name survives a restart", async ({ tempHome, request }) => {
    let agentId: string;

    const first = await launchApp(tempHome);
    try {
      const window = await first.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await bootWorkspaceWithTerminal(first, window, tempHome, "agent-rename-restart");
      const { session } = await startNamedAgent(window, tempHome, request);
      agentId = session.id;

      const row = sidebarRow(window, agentId);
      await expect(nameIn(row)).toHaveText(AGENT_TITLE, { timeout: 30_000 });
      await renameThrough(row, "Kept after restart");
      await expect
        .poll(() => persistedName(tempHome, agentId), { timeout: 15_000 })
        .toEqual({ name: "Kept after restart", namePinned: true });
    } finally {
      await killApp(first);
    }

    const relaunched = await launchApp(tempHome);
    try {
      const window = await relaunched.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      // The sidebar only lists agents whose pane is in a layout, and the
      // layout that comes back after a restart is the app's business. The
      // Agents modal lists every record, so open it from the palette.
      await expect(window.getByTestId("notifications-bell")).toBeVisible({
        timeout: 30_000,
      });
      await window.keyboard.press("Meta+k");
      const paletteInput = window.getByPlaceholder("Type a command...");
      await expect(paletteInput).toBeVisible({ timeout: 10_000 });
      await paletteInput.fill("View All Agents");
      const item = window
        .locator("[cmdk-item]", { hasText: "View All Agents" })
        .first();
      await expect(item).toBeVisible();
      await item.click();
      const modal = window.getByTestId("agents-modal");
      await expect(modal).toBeVisible({ timeout: 15_000 });

      await expect(nameIn(modalRow(window, agentId!))).toHaveText(
        "Kept after restart",
        { timeout: 15_000 },
      );
      expect(persistedName(tempHome, agentId!)).toEqual({
        name: "Kept after restart",
        namePinned: true,
      });
    } finally {
      await killApp(relaunched);
    }
  });
});
