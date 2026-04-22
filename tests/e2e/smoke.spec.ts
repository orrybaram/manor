import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  test,
} from "./fixtures";

test("pane lifecycle", async ({ app, window, tempHome }) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "smoke-test-workspace");

  // split-panel-right (Meta+Alt+\): add a second panel beside the first.
  await window.keyboard.press("Meta+Alt+\\");
  await assertVisiblePaneCount(window, 2, 5_000);

  // close-pane (Meta+W): no active agent, so no close-confirm dialog should appear.
  await window.keyboard.press("Meta+w");
  await assertVisiblePaneCount(window, 1, 5_000);
});
