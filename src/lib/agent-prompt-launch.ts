import { layoutKeyFor, selectActiveWorkspaceKey, useAppStore } from "../store/app-store";
import type { HostId } from "./hosts";
import { ownerOf } from "./workspace-directory";
import { parseWorkspaceKey } from "./workspace-key";
import { useProjectStore } from "../store/project-store";
import { getAgentCommand } from "../agent-defaults";
import { agentCommandWithPrompt } from "./agent-command";

/**
 * Open a new agent tab in `workspacePath`, optionally seeded with `prompt` as
 * its first message and an explicit `agentCommand` override.
 *
 * Every step keys off the given `workspacePath`, not whatever happens to be
 * active: the workspace is selected first — through the project store, so the
 * sidebar highlight and main's persisted selection follow — the launch
 * command is resolved via `getAgentCommand`, the prompt (if any) is
 * flattened before it is queued for the new tab's pane on the server
 * (ADR-179 ticket 11), and the tab is opened. Prewarmed sessions are not
 * consumed: they run the bare agent command, and a seeded launch needs the
 * command-with-prompt argument.
 *
 * Shared by `startAgentWithPrompt` (fire-and-forget, no override, no return
 * value) and the agent-resume/new-agent surfaces — the callers that used to
 * hand-roll this sequence with different gaps (ADR-176). Launches that arrive
 * over the control server do not come through here at all any more: `POST
 * /agents` does the same two steps on the server and needs no window.
 *
 * `hostId` is the workspace's host: the same path can be on two (ADR-191).
 */
export function launchAgentInWorkspace(
  workspacePath: string,
  options: { prompt?: string; agentCommand?: string; hostId?: HostId | null } = {},
): { tabId: string; paneId: string } | null {
  const key = layoutKeyFor(workspacePath, options.hostId);
  const project = ownerOf(useProjectStore.getState().projects, key);
  const index = project?.workspaces.findIndex((w) => w.path === workspacePath) ?? -1;
  if (project && index >= 0) {
    useProjectStore.getState().selectWorkspace(project.id, index);
  }

  const app = useAppStore.getState();
  if (selectActiveWorkspaceKey(app) !== key) {
    app.setActiveWorkspace(workspacePath, parseWorkspaceKey(key).hostId);
  }

  const base = getAgentCommand(key, options.agentCommand);
  // Queued on the new tab's own pane, not the workspace, on the server:
  // whichever renderer mounts that pane first types it (ADR-179 ticket 11).
  return useAppStore
    .getState()
    .addTerminalTab(agentCommandWithPrompt(base, options.prompt), {
      kind: "agent-startup",
    });
}

/**
 * Open a new agent tab in `workspacePath` with `prompt` as its first message.
 * See `launchAgentInWorkspace` for the full behavior; this is the
 * fire-and-forget wrapper used by callers that don't need the created
 * tab/pane back (e.g. the PR review "reply as agent" flow).
 */
export function startAgentWithPrompt(
  workspacePath: string,
  prompt: string,
  hostId?: HostId | null,
): void {
  launchAgentInWorkspace(workspacePath, { prompt, hostId });
}
