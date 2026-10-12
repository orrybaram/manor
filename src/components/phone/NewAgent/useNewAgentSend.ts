import { useCallback } from "react";
import { getAgentKindForCommand } from "../../../agent-defaults";
import { launchAgentInWorkspace } from "../../../lib/agent-prompt-launch";
import { resolveWorkspaceCommand } from "../../../lib/keybinding-commands";
import { workspaceKey } from "../../../lib/workspace-key";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { sanitizeBranchName, worktreeNameFromPrompt } from "../../../utils/branch-name";
import { markChatStarting } from "../ChatPane/usePaneChatView";
import { resolveTarget, type NewAgentTarget, type ResolvedTarget } from "./new-agent-target";

/** Names a new worktree must not take: the project's workspace names, branches and directories. */
function takenNames(project: ProjectInfo): Set<string> {
  const taken = new Set<string>();
  for (const w of project.workspaces) {
    if (w.name) taken.add(w.name);
    if (w.branch) taken.add(w.branch);
    const dir = w.path.split("/").pop();
    if (dir) taken.add(dir);
  }
  return taken;
}

/** Whether the agent the target's workspace launches is Claude (a chat from the start, ADR-215 D7). */
function isClaudeAt(resolved: ResolvedTarget<ProjectInfo>): boolean {
  const key = workspaceKey(resolved.hostId, resolved.workspace.path);
  return getAgentKindForCommand(resolveWorkspaceCommand(key)) === "claude";
}

/** Start the agent in an existing workspace (or main) right away. */
function sendToWorkspace(prompt: string, resolved: ResolvedTarget<ProjectInfo>): void {
  const { project, workspace, hostId } = resolved;
  const claude = isClaudeAt(resolved);
  const opened = launchAgentInWorkspace(workspace.path, { prompt, hostId: project.hostId });
  if (opened && claude) markChatStarting(opened.paneId);
  if (project.group) void useProjectStore.getState().setGroupLastUsedHost(project.group.id, hostId);
  const app = useAppStore.getState();
  app.clearComposerDraft();
  app.closeComposer();
}

/**
 * Make a worktree named after the prompt, branched off the target workspace
 * (main: the default branch), with the agent queued in it. The composer
 * closes at once so the setup view shows progress; the draft is cleared only
 * once the worktree exists, so a failure (toasted by `createWorktree`) keeps it.
 */
async function sendToNewWorktree(prompt: string, resolved: ResolvedTarget<ProjectInfo>): Promise<void> {
  const { project, workspace } = resolved;
  const claude = isClaudeAt(resolved);
  const name = worktreeNameFromPrompt(prompt, takenNames(project));
  const app = useAppStore.getState();
  app.closeComposer();
  const created = await useProjectStore.getState().createWorktree(project.id, name, {
    branch: sanitizeBranchName(name),
    baseBranch: workspace.isMain ? undefined : workspace.branch,
    agentPrompt: prompt,
    onAgentPane: (paneId) => {
      if (claude) markChatStarting(paneId);
    },
  });
  if (created !== null) useAppStore.getState().clearComposerDraft();
}

/**
 * The phone new-agent composer's send (ADR-222 D6): launch `prompt` at
 * `target`. Nothing happens for a blank prompt or a target that went stale.
 */
export function useNewAgentSend(): (prompt: string, target: NewAgentTarget) => void {
  return useCallback((rawPrompt: string, target: NewAgentTarget) => {
    const prompt = rawPrompt.trimEnd();
    if (prompt.trim().length === 0) return;
    const resolved = resolveTarget(target, useProjectStore.getState().projects);
    if (!resolved) return;
    if (target.newWorktree) void sendToNewWorktree(prompt, resolved);
    else sendToWorkspace(prompt, resolved);
  }, []);
}
