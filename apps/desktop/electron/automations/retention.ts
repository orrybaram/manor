import type { AgentManager } from "../agent-persistence";
import type { AgentStatusDriver } from "../agent-status/driver";
import type { UnseenAgents } from "../agent-status/unseen-agents";
import type { LayoutStore } from "../layout/layout-store";
import type { ProjectManager } from "../persistence";
import type { ProjectInfo, WorkspaceInfo } from "../projects/types";
import type { WorkspaceOps } from "../workspace-ops";
import type { Automation, AutomationRun } from "../../src/lib/automations";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import { parseWorkspaceKey, workspaceKey } from "../../src/lib/workspace-key";
import { isRunAgentBusy, runAgent } from "./run-agent";

/**
 * Keep last N: once a new-workspace run has started, the automation's older
 * run workspaces beyond the newest `keepLast` are removed.
 *
 * An automation's run workspaces are the ones its started runs recorded
 * (`workspacePath`, with the `workspaceName` the run gave it) that are still
 * in the project — never a workspace matched by name. Only the runs the
 * store still holds are looked at.
 *
 * A run workspace is the user's, and is kept without counting towards N,
 * when any of these holds: it was renamed, moved out of the Automations
 * folder or hidden; it holds a pane other than the run's own (the user
 * opened something in it); the run's Agent is still active, busy, or has a
 * reply or question nobody has seen; any other Agent in it is active; or
 * removing it would lose work (`worktreeRemovalRisk`: changes, untracked
 * or recently written ignored files, submodules, commits on neither the
 * default branch nor a remote). The rest, newest first, fill the N slots
 * (the run that just started takes one) and those left over are removed
 * through the same path as the sidebar's remove, which keeps the branch.
 * Every check is asked again just before each removal.
 *
 * One automation's prunes run one at a time (`createRunWorkspacePruner`): a
 * catch-up and a Run now never weigh the same workspaces at once.
 *
 * Nothing here throws: a failed removal is logged and the next is tried.
 * When in doubt, a workspace stays.
 */

/** The sidebar folder a project's run workspaces go in. */
export const AUTOMATIONS_FOLDER = "Automations";

export interface RunWorkspaceRetentionDeps {
  /** The automation's runs, newest first. */
  runs: (automationId: string) => readonly AutomationRun[];
  projectManager: Pick<ProjectManager, "getProjects" | "worktreeRemovalRisk">;
  workspaceOps: Pick<WorkspaceOps, "remove">;
  agentManager: Pick<AgentManager, "getAllAgents" | "getAgentById">;
  agentStatus: Pick<AgentStatusDriver, "getPaneState">;
  /** The server's layouts: which panes a workspace holds. */
  layout: Pick<LayoutStore, "get">;
  /** Agents whose reply or question nobody has looked at yet. */
  unseen: Pick<UnseenAgents, "responded" | "requiresInput">;
  log: (message: string) => void;
}

/**
 * `pruneRunWorkspaces` over `deps`, one at a time per automation: a prune
 * asked for while the automation's last is still going waits for it.
 */
export function createRunWorkspacePruner(
  deps: RunWorkspaceRetentionDeps,
): (automation: Automation, currentPath: string) => Promise<void> {
  const tails = new Map<string, Promise<void>>();
  return (automation, currentPath) => {
    const previous = tails.get(automation.id) ?? Promise.resolve();
    const next = previous.then(() => pruneRunWorkspaces(deps, automation, currentPath));
    tails.set(automation.id, next);
    void next.then(() => {
      if (tails.get(automation.id) === next) tails.delete(automation.id);
    });
    return next;
  };
}

/**
 * Removes `automation`'s run workspaces beyond its `keepLast`, keeping
 * `currentPath` (the run that just started) as one of them.
 */
export async function pruneRunWorkspaces(
  deps: RunWorkspaceRetentionDeps,
  automation: Automation,
  currentPath: string,
): Promise<void> {
  const spec = automation.workspace;
  if (spec.mode !== "new" || !spec.keepLast) return;
  const keepLast = spec.keepLast;
  const prefix = `automation ${automation.id}: keep last ${keepLast}`;
  try {
    const project = await findProject(deps, automation.projectId);
    if (!project) return;

    const seen = new Set([samePath(currentPath)]);
    const kept: string[] = [];
    const removable: AutomationRun[] = [];
    let slots = keepLast - 1;
    for (const run of deps.runs(automation.id)) {
      if (run.outcome !== "started" || !run.workspacePath || !run.workspaceName) continue;
      const at = samePath(run.workspacePath);
      if (seen.has(at)) continue;
      seen.add(at);
      const ws = workspaceAt(project, at);
      if (!ws || ws.isMain) continue;
      const why = await keptBecause(deps, project, ws, run);
      if (why) {
        kept.push(`${ws.name ?? ws.path} (${why})`);
        continue;
      }
      if (slots > 0) {
        slots--;
        continue;
      }
      removable.push(run);
    }

    for (const run of removable) {
      try {
        // Asked again now: an earlier removal took time, and the user may
        // have opened, renamed or changed this one meanwhile.
        const fresh = await findProject(deps, automation.projectId);
        const ws = fresh && workspaceAt(fresh, samePath(run.workspacePath!));
        if (!fresh || !ws || ws.isMain) continue;
        const why = await keptBecause(deps, fresh, ws, run);
        if (why) {
          kept.push(`${ws.name ?? ws.path} (${why})`);
          continue;
        }
        await deps.workspaceOps.remove(fresh.id, ws.path);
      } catch (err) {
        deps.log(`${prefix}: removing ${run.workspacePath} failed: ${errorMessage(err)}`);
      }
    }
    if (kept.length > 0) deps.log(`${prefix}: kept ${kept.join(", ")}`);
  } catch (err) {
    deps.log(`${prefix}: ${errorMessage(err)}`);
  }
}

async function findProject(deps: RunWorkspaceRetentionDeps, projectId: string): Promise<ProjectInfo | undefined> {
  return (await deps.projectManager.getProjects()).find((p) => p.id === projectId);
}

function workspaceAt(project: ProjectInfo, at: string): WorkspaceInfo | undefined {
  return project.workspaces.find((ws) => samePath(ws.path) === at);
}

/**
 * A workspace path or key as one comparable form: the bare path, without
 * trailing slashes. A key's host is dropped, so the same path on any host
 * matches — a match only ever keeps a workspace.
 */
function samePath(pathOrKey: string): string {
  const bare = parseWorkspaceKey(pathOrKey).path;
  return bare.length > 1 ? bare.replace(/[\\/]+$/, "") : bare;
}

/** Why `ws`, made by `run`, is the user's now and must stay, or null when it may go. */
async function keptBecause(
  deps: RunWorkspaceRetentionDeps,
  project: ProjectInfo,
  ws: WorkspaceInfo,
  run: AutomationRun,
): Promise<string | null> {
  const folderId = project.folders.find((f) => f.name === AUTOMATIONS_FOLDER && f.parentId == null)?.id;
  if (ws.name !== run.workspaceName) return "renamed";
  if (!folderId || ws.folderId !== folderId) return "moved";
  if (ws.hidden) return "hidden";

  const entry = deps.layout.get(workspaceKey(project.hostId, ws.path));
  if (entry) {
    for (const panel of Object.values(entry.layout.panels)) {
      for (const tab of panel.tabs) {
        if (allPaneIds(tab.rootNode).some((paneId) => paneId !== run.paneId)) return "a pane was opened in it";
      }
    }
  }

  const { agent } = runAgent(deps, run);
  if (agent?.status === "active") return "its agent is active";
  if (isRunAgentBusy(deps, run)) return "its agent is working";
  if (agent && (deps.unseen.responded.has(agent.id) || deps.unseen.requiresInput.has(agent.id))) {
    return "its agent's reply is unread";
  }
  const at = samePath(ws.path);
  if (deps.agentManager.getAllAgents().some((a) => a.status === "active" && a.workspacePath && samePath(a.workspacePath) === at)) {
    return "an agent is active";
  }

  try {
    const createdAt = Date.parse(run.firedAt);
    return await deps.projectManager.worktreeRemovalRisk(project.id, ws.path, {
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    });
  } catch (err) {
    return errorMessage(err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
