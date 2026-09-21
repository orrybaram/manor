import type { Page } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import { awaitShellReady, scrollback } from "./helpers/terminal";

/** The pane ids of every pane the active tab is showing, in DOM order. */
async function visiblePaneIds(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="workspace-pane"]:visible')
    .evaluateAll((panes) =>
      panes.map((pane) => pane.getAttribute("data-pane-id") ?? ""),
    );
}

/** Focus one named pane's terminal and run a command in it. */
async function typeInPane(
  window: Page,
  paneId: string,
  command: string,
): Promise<void> {
  await window
    .locator(`[data-pane-id="${paneId}"] [data-testid="terminal-pane"]`)
    .click();
  await window.keyboard.type(command);
  await window.keyboard.press("Enter");
}

test("pane lifecycle", async ({ app, window, tempHome }) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "smoke-test-workspace");

  // split-panel-right (Meta+Alt+\): add a second panel beside the first.
  await window.keyboard.press("Meta+Alt+\\");
  await assertVisiblePaneCount(window, 2, 5_000);

  // close-pane (Meta+W): no active agent, so no close-confirm dialog should appear.
  await window.keyboard.press("Meta+w");
  await assertVisiblePaneCount(window, 1, 5_000);
});

/**
 * Reopen is an undo, so the shell has to survive the close (ADR-179 t10).
 *
 * The server holds the kill for a grace period; a reopen inside it cancels
 * the kill and reattaches the same session. A shell variable is the proof
 * that nothing respawned: a fresh zsh would print an empty one.
 */
test("reopening a closed pane reattaches the same shell", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "reopen-workspace");
  const [firstPaneId] = await visiblePaneIds(window);

  await window.keyboard.press("Meta+d");
  await assertVisiblePaneCount(window, 2);
  const paneId = (await visiblePaneIds(window)).find((id) => id !== firstPaneId);
  expect(paneId).toBeTruthy();
  await awaitShellReady(window, tempHome, paneId!);

  await typeInPane(window, paneId!, "MARK=warm-reopen");
  await expect
    .poll(() => scrollback(tempHome, paneId!), { timeout: 15_000 })
    .toContain("MARK=warm-reopen");

  await window.keyboard.press("Meta+w");
  await assertVisiblePaneCount(window, 1);

  // Well inside the 10s grace: the session is still warm on the server.
  await window.keyboard.press("Meta+Shift+t");
  await assertVisiblePaneCount(window, 2);
  expect(await visiblePaneIds(window)).toContain(paneId!);

  await typeInPane(window, paneId!, 'echo "mark:$MARK"');
  await expect
    .poll(() => scrollback(tempHome, paneId!), { timeout: 15_000 })
    .toContain("mark:warm-reopen");
});
