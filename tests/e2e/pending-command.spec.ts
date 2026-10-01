import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import { layout, newTab, splitPane } from "./helpers/local-api";
import { scrollback } from "./helpers/terminal";

/**
 * "Open a pane and run this in it", asked for over HTTP.
 *
 * `POST /tabs` and `POST /panes/split` accept a `command`, and MCP's
 * `new_tab` / `split_pane` — the agent fan-out's hands — depend on it. The
 * command is queued on the Manor server rather than a renderer's own map, so
 * a route that mints a pane with nothing on screen still runs the command it
 * opened with.
 *
 * Nothing here touches the UI: the request goes to the control server and the
 * proof is in the daemon's own scrollback for the pane the route minted. A
 * renderer is still what mounts the pane — that is what makes the command
 * run at all — but it is not where the command waited.
 */

test("a tab opened over HTTP with a command runs it", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "pending-cmd-ws");
  const { workspacePath } = await layout(request, tempHome);

  const { paneId } = await newTab(request, tempHome, {
    contentType: "terminal",
    workspacePath,
    command: "echo mark:pending-cmd",
  });

  // The desktop mounts the new tab's pane, its `pty.create` takes the queued
  // line, and the daemon writes it once the shell has a prompt.
  await assertVisiblePaneCount(window, 1);
  await expect
    .poll(() => scrollback(tempHome, paneId), { timeout: 30_000 })
    .toContain("mark:pending-cmd");

  // Typed once, not once per viewer: the mark appears as the echoed command
  // line and as its output, and no more than that.
  const occurrences = scrollback(tempHome, paneId).split(
    "mark:pending-cmd",
  ).length;
  expect(occurrences).toBeLessThanOrEqual(3);
});

test("a split opened over HTTP with a command runs it in the new pane", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "pending-split-ws");
  const snapshot = await layout(request, tempHome);
  const existingPaneId = snapshot.tabs.flatMap((tab) =>
    tab.panes.map((pane) => pane.paneId),
  )[0];

  const { paneId } = await splitPane(request, tempHome, {
    paneId: existingPaneId,
    direction: "horizontal",
    workspacePath: snapshot.workspacePath,
    command: "echo mark:split-cmd",
  });

  await assertVisiblePaneCount(window, 2);
  await expect
    .poll(() => scrollback(tempHome, paneId), { timeout: 30_000 })
    .toContain("mark:split-cmd");
  // The pane that was already open is not the one that was asked to run it.
  expect(scrollback(tempHome, existingPaneId)).not.toContain("mark:split-cmd");
});
