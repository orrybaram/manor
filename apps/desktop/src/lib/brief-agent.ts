import { layoutKeyFor, useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { useProjectStore } from "../store/project-store";
import { agentWorkspaceKey, navigateToAgent } from "../utils/agent-navigation";
import { cleanAgentTitle } from "../utils/agent-title";
import { launchAgentInWorkspace } from "./agent-prompt-launch";
import { hasPaneId } from "./layout/pane-tree";
import { pickPromptTarget } from "./prompt-target";
import type { HostId } from "./hosts";

/** Where a brief went: typed into a waiting agent, or a new agent's first message. */
export type BriefDelivery = { kind: "sent"; agentName: string } | { kind: "started" };

/**
 * Hand `prompt` to the workspace's agent: the most recent one waiting for its
 * next prompt gets it typed in (and is brought on screen), and when every
 * agent there is busy, or there is none, a new agent tab starts with it.
 * A busy agent is never interrupted (`pickPromptTarget`).
 */
export async function briefWorkspaceAgent(
  workspacePath: string,
  prompt: string,
  hostId?: HostId | null,
): Promise<BriefDelivery> {
  const key = layoutKeyFor(workspacePath, hostId);
  const projects = useProjectStore.getState().projects;
  const layout = useAppStore.getState().workspaceLayouts[key];
  const inWorkspace = useAgentStore
    .getState()
    .agents.filter((a) => agentWorkspaceKey(a, projects) === key);
  const target = pickPromptTarget(inWorkspace, (paneId) =>
    Object.values(layout?.panels ?? {}).some((panel) =>
      panel.tabs.some((tab) => hasPaneId(tab.rootNode, paneId)),
    ),
  );

  if (target) {
    try {
      await window.electronAPI.chat.send(target.paneId, prompt);
      navigateToAgent(target);
      return { kind: "sent", agentName: cleanAgentTitle(target.name) ?? "the agent" };
    } catch {
      // An agent kind the chat input cannot type for: a new agent still gets it.
    }
  }
  launchAgentInWorkspace(workspacePath, { prompt, hostId });
  return { kind: "started" };
}
