import { layoutKeyFor, selectActiveWorkspaceKey, useAppStore } from "../store/app-store";
import type { HostId } from "./hosts";
import { ownerOf } from "./workspace-directory";
import { parseWorkspaceKey } from "./workspace-key";
import { useProjectStore } from "../store/project-store";
import { getAgentCommand } from "../agent-defaults";

/** A blank prompt is no prompt (ADR-209), matching `POST /agents`. */
function promptOrUndefined(prompt: string | undefined): string | undefined {
  return prompt?.trim() ? prompt : undefined;
}

/**
 * Open a new agent tab in `workspacePath`, optionally seeded with `prompt` as
 * its first message and an explicit `agentCommand` override.
 *
 * Every step keys off the given `workspacePath`, not whatever happens to be
 * active: the workspace is selected first — through the project store, so the
 * sidebar highlight and main's persisted selection follow — the launch
 * command is resolved via `getAgentCommand`, the command and the
 * prompt (if any) are queued separately for the new tab's pane on the server
 * (ADR-179 ticket 11) — which delivers the prompt through a file on the
 * pane's host (ADR-209) — and the tab is opened. Prewarmed sessions are not
 * consumed: they run the bare agent command, and a seeded launch needs the
 * prompt argument.
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
  // The prompt travels beside the bare command, not inside it: the server
  // delivers it through a file on the pane's host (ADR-209).
  return useAppStore.getState().addTerminalTab(base, {
    kind: "agent-startup",
    prompt: promptOrUndefined(options.prompt),
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

/**
 * Open a new agent tab in `workspacePath` with `prompt` as its first message,
 * without leaving the current view: no workspace is selected and the active
 * surface stays put. For launches from the Dashboard, which confirm with a
 * toast instead of taking the user to the agent.
 */
export function startAgentInBackground(
  workspacePath: string,
  prompt: string,
  hostId?: HostId | null,
): void {
  const key = layoutKeyFor(workspacePath, hostId);
  useAppStore.getState().addTerminalTabIn(key, getAgentCommand(key), {
    kind: "agent-startup",
    prompt: promptOrUndefined(prompt),
  });
}
