import { layoutKeyFor, selectActiveWorkspaceKey, useAppStore } from "../store/app-store";
import { projectForWorkspaceKey, type HostId } from "./hosts";
import { parseWorkspaceKey } from "./workspace-key";
import { useProjectStore } from "../store/project-store";
import { getAgentCommand } from "../agent-defaults";
import { escapeShellDoubleQuoted } from "./home";

/**
 * Flatten a prompt to a single line. Prompts here are typed into an
 * interactive shell or a harness's prompt box, and a bare newline either
 * leaves the shell waiting on a continuation prompt or submits the turn
 * early — so every whitespace run that spans a newline collapses to one
 * space before the text is sent.
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Open a new agent tab in `workspacePath`, optionally seeded with `prompt` as
 * its first message and an explicit `agentCommand` override.
 *
 * Every step keys off the given `workspacePath`, not whatever happens to be
 * active: the workspace is selected first — through the project store, so the
 * sidebar highlight and main's persisted selection follow — the launch
 * command is resolved via `getAgentCommand`, the prompt
 * (if any) is flattened before it is queued as that workspace's pending
 * startup command, and a new tab is opened for it. Prewarmed sessions are not
 * consumed: they run the bare agent command, and a seeded launch needs the
 * command-with-prompt argument.
 *
 * Shared by `startAgentWithPrompt` (fire-and-forget, no override, no return
 * value) and the correlated `start-agent` app-command in `app-commands.ts`
 * (which reports the created tab/pane back to main and may carry an explicit
 * `agentCommand`) — the two callers that used to hand-roll this sequence with
 * different gaps (ADR-176).
 *
 * `hostId` is the workspace's host: the same path can be on two (ADR-191).
 */
export function launchAgentInWorkspace(
  workspacePath: string,
  options: { prompt?: string; agentCommand?: string; hostId?: HostId | null } = {},
): { tabId: string; paneId: string } | null {
  const key = layoutKeyFor(workspacePath, options.hostId);
  const project = projectForWorkspaceKey(useProjectStore.getState().projects, key);
  const index = project?.workspaces.findIndex((w) => w.path === workspacePath) ?? -1;
  if (project && index >= 0) {
    useProjectStore.getState().selectWorkspace(project.id, index);
  }

  const app = useAppStore.getState();
  if (selectActiveWorkspaceKey(app) !== key) {
    app.setActiveWorkspace(workspacePath, parseWorkspaceKey(key).hostId);
  }

  const base = getAgentCommand(workspacePath, options.agentCommand);
  const command = options.prompt
    ? `${base} "${escapeShellDoubleQuoted(flattenPrompt(options.prompt))}"`
    : base;
  useAppStore.getState().setPendingStartupCommand(workspacePath, command);

  return useAppStore.getState().addTab();
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
