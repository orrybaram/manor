import { useAppStore } from "../store/app-store";
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
 * command is resolved home-harness-aware via `getAgentCommand`, the prompt
 * (if any) is flattened before it is queued for the new tab's pane on the
 * server (ADR-179 ticket 11), and the tab is opened. Prewarmed sessions are
 * not consumed: they run the bare agent command, and a seeded launch needs
 * the command-with-prompt argument.
 *
 * Shared by `startAgentWithPrompt` (fire-and-forget, no override, no return
 * value) and the agent-resume/new-agent surfaces — the callers that used to
 * hand-roll this sequence with different gaps (ADR-176). Launches that arrive
 * over the control server do not come through here at all any more: `POST
 * /agents` does the same two steps on the server and needs no window.
 */
export function launchAgentInWorkspace(
  workspacePath: string,
  options: { prompt?: string; agentCommand?: string } = {},
): { tabId: string; paneId: string } | null {
  const projects = useProjectStore.getState().projects;
  for (const project of projects) {
    const index = project.workspaces.findIndex((w) => w.path === workspacePath);
    if (index >= 0) {
      useProjectStore.getState().selectWorkspace(project.id, index);
      break;
    }
  }

  const app = useAppStore.getState();
  if (app.activeWorkspacePath !== workspacePath) {
    app.setActiveWorkspace(workspacePath);
  }

  const base = getAgentCommand(workspacePath, options.agentCommand);
  return useAppStore
    .getState()
    .addTerminalTab(
      agentCommandWithPrompt(base, options.prompt),
      "agent-startup",
    );
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
): void {
  launchAgentInWorkspace(workspacePath, { prompt });
}
