/**
 * Repairs Agents that were recorded without a project.
 *
 * Main tags a new Agent with the context its pane registered on mount
 * (`agents:setPaneContext`). After a restart — typically an update — live
 * sessions' hooks can arrive before their panes mount, and a pane in a
 * workspace nobody has opened yet never mounts at all. Such an Agent has no
 * project or workspace: the sidebar files it under "Unknown" and clicking it
 * does nothing.
 *
 * The persisted layouts already say which workspace each pane lives in, so
 * that is where the missing context comes from. Main fills only the empty
 * fields, so re-sending a context is harmless.
 */

import { parseWorkspaceKey } from "./workspace-key";
import { ownerOf } from "./workspace-directory";
import { isHomePath } from "./home";
import { allPaneIds, type PaneNode } from "../lib/layout/pane-tree";
import type { AgentInfo } from "../electron.d";
import type { ProjectInfo } from "../store/project-store";

export interface PaneContext {
  projectId: string;
  projectName: string;
  workspacePath: string;
  agentCommand: string | null;
}

/** The part of a workspace layout this derivation reads. */
export interface LayoutPanes {
  panels: Record<string, { tabs: ReadonlyArray<{ rootNode: PaneNode }> }>;
}

/** Whether `agent` is live on a pane but missing the workspace it runs in. */
function lacksContext(agent: AgentInfo): agent is AgentInfo & { paneId: string } {
  return (
    agent.status === "active" &&
    agent.paneId != null &&
    (!agent.workspacePath || (!agent.projectId && !agent.projectName))
  );
}

/**
 * The pane contexts to send for every active Agent that lacks one, keyed by
 * pane id. A pane found in no layout, or in a workspace no project owns, is
 * left alone: guessing would file the Agent under the wrong project.
 */
export function orphanedAgentContexts(
  agents: readonly AgentInfo[],
  workspaceLayouts: Readonly<Record<string, LayoutPanes>>,
  projects: readonly ProjectInfo[],
): Map<string, PaneContext> {
  const wanted = new Set(agents.filter(lacksContext).map((a) => a.paneId));
  const contexts = new Map<string, PaneContext>();
  if (wanted.size === 0) return contexts;

  for (const [key, layout] of Object.entries(workspaceLayouts)) {
    const paneIds = Object.values(layout.panels)
      .flatMap((panel) => panel.tabs.flatMap((tab) => allPaneIds(tab.rootNode)))
      .filter((id) => wanted.has(id));
    if (paneIds.length === 0) continue;

    const { path } = parseWorkspaceKey(key);
    // Orphaned Home agents (Home is the tab-less Dashboard, ADR-197) have no
    // owning project, so they get no context.
    if (isHomePath(path)) continue;
    const project = ownerOf(projects, key);
    if (!project) continue;
    const context: PaneContext = {
      projectId: project.id,
      projectName: project.name,
      workspacePath: path,
      agentCommand: project.agentCommand ?? null,
    };
    for (const id of paneIds) contexts.set(id, context);
  }
  return contexts;
}
