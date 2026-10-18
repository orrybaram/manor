import { DEFAULT_AGENT_COMMAND, getAgentKindForCommand } from "../../../agent-defaults";
import { launchAgentInWorkspace } from "../../../lib/agent-prompt-launch";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { worktreeNameFromPrompt } from "../../../utils/branch-name";
import { markChatStarting } from "../ChatPane/usePaneChatView";
import { baseBranchOf, resolveTarget, type NewAgentTarget, type ResolvedTarget } from "./new-agent-target";

/**
 * Names a new worktree must not take, lowercased (prompt names are, and git
 * refs can clash by case on a case-insensitive disk): the project's workspace
 * names, branches and directories, and every local branch. Creation checks
 * out a branch that already exists instead of failing, so a stale branch
 * with no worktree must count too. A failed branch listing leaves the
 * workspaces' branches.
 */
async function takenNames(project: ProjectInfo): Promise<Set<string>> {
  const taken = new Set<string>();
  const add = (name: string | null | undefined) => {
    if (name) taken.add(name.toLowerCase());
  };
  for (const w of project.workspaces) {
    add(w.name);
    add(w.branch);
    add(w.path.split("/").pop());
  }
  const branches = await window.electronAPI.projects.listLocalBranches(project.id).catch(() => []);
  for (const branch of branches) add(branch);
  return taken;
}

/** Whether `project` launches Claude (a chat from the start, ADR-215 D7). */
function isClaude(project: ProjectInfo): boolean {
  return getAgentKindForCommand(project.agentCommand ?? DEFAULT_AGENT_COMMAND) === "claude";
}

/** Start the agent in an existing workspace (or main) right away. */
function sendToWorkspace(prompt: string, resolved: ResolvedTarget<ProjectInfo>): void {
  const { project, workspace, hostId } = resolved;
  // Opening the tab leaves the composer surface (`addTerminalTab`); when
  // there was nowhere to open it, the composer and its draft stay.
  const opened = launchAgentInWorkspace(workspace.path, { prompt, hostId: project.hostId });
  if (!opened) return;
  if (isClaude(project)) markChatStarting(opened.paneId, null, prompt);
  if (project.group) void useProjectStore.getState().setGroupLastUsedHost(project.group.id, hostId);
  useAppStore.getState().clearComposerDraft();
}

/**
 * Make a worktree named after the prompt, branched off the target workspace
 * (`baseBranchOf`), with the agent queued in it. The composer closes at once
 * so the setup view shows progress; the draft is cleared only once the
 * worktree exists, so a failure (toasted by `createWorktree`) keeps it.
 */
async function sendToNewWorktree(prompt: string, resolved: ResolvedTarget<ProjectInfo>): Promise<void> {
  const { project } = resolved;
  const claude = isClaude(project);
  useAppStore.getState().closeComposer();
  const name = worktreeNameFromPrompt(prompt, await takenNames(project));
  // No `branch`: the name is a dir slug, already a valid ref, and creation
  // names the branch after it.
  const created = await useProjectStore.getState().createWorktree(project.id, name, {
    baseBranch: baseBranchOf(resolved),
    agentPrompt: prompt,
    onAgentPane: (paneId) => {
      if (claude) markChatStarting(paneId, null, prompt);
    },
  });
  if (created !== null) useAppStore.getState().clearComposerDraft();
}

/**
 * The phone new-agent composer's send (ADR-222 D6): launch `prompt` at
 * `target`. Nothing happens for a blank prompt or a target that went stale.
 */
export function sendNewAgent(rawPrompt: string, target: NewAgentTarget): void {
  const prompt = rawPrompt.trimEnd();
  if (prompt.trim().length === 0) return;
  const resolved = resolveTarget(target, useProjectStore.getState().projects);
  if (!resolved) return;
  if (target.newWorktree) void sendToNewWorktree(prompt, resolved);
  else sendToWorkspace(prompt, resolved);
}
