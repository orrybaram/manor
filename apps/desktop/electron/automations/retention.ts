import type { AgentManager } from "../agent-persistence";
import type { ProjectManager } from "../persistence";
import type { WorkspaceInfo } from "../projects/types";
import type { WorkspaceOps } from "../workspace-ops";
import type { Automation, AutomationRun } from "../../src/lib/automations";

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
 * folder or hidden; an Agent in it is still active; or removing it would
 * lose work — uncommitted or untracked changes, or commits on neither the
 * default branch nor a remote (`worktreeRemovalRisk`). The rest, newest
 * first, fill the N slots (the run that just started takes one) and those
 * left over are removed through the same path as the sidebar's remove, which
 * keeps the branch.
 *
 * Nothing here throws: a failed removal is logged and the next is tried.
 */

/** The sidebar folder a project's run workspaces go in. */
export const AUTOMATIONS_FOLDER = "Automations";

export interface RunWorkspaceRetentionDeps {
  /** The automation's runs, newest first. */
  runs: (automationId: string) => readonly AutomationRun[];
  projectManager: Pick<ProjectManager, "getProjects" | "worktreeRemovalRisk">;
  workspaceOps: Pick<WorkspaceOps, "remove">;
  agentManager: Pick<AgentManager, "getAllAgents">;
  log: (message: string) => void;
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
    const project = (await deps.projectManager.getProjects()).find((p) => p.id === automation.projectId);
    if (!project) return;
    const workspaces = new Map(project.workspaces.map((ws) => [ws.path, ws]));
    const folderId = project.folders.find((f) => f.name === AUTOMATIONS_FOLDER && f.parentId == null)?.id;

    const seen = new Set([currentPath]);
    const kept: string[] = [];
    const removable: WorkspaceInfo[] = [];
    let slots = keepLast - 1;
    for (const run of deps.runs(automation.id)) {
      if (run.outcome !== "started" || !run.workspacePath || !run.workspaceName) continue;
      if (seen.has(run.workspacePath)) continue;
      seen.add(run.workspacePath);
      const ws = workspaces.get(run.workspacePath);
      if (!ws || ws.isMain) continue;
      const why = await keptBecause(deps, project.id, ws, run.workspaceName, folderId);
      if (why) {
        kept.push(`${ws.name ?? ws.path} (${why})`);
        continue;
      }
      if (slots > 0) {
        slots--;
        continue;
      }
      removable.push(ws);
    }
    if (kept.length > 0) deps.log(`${prefix}: kept ${kept.join(", ")}`);

    for (const ws of removable) {
      try {
        await deps.workspaceOps.remove(project.id, ws.path);
      } catch (err) {
        deps.log(`${prefix}: removing ${ws.path} failed: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    deps.log(`${prefix}: ${errorMessage(err)}`);
  }
}

/** Why `ws` is the user's now and must stay, or null when it may go. */
async function keptBecause(
  deps: RunWorkspaceRetentionDeps,
  projectId: string,
  ws: WorkspaceInfo,
  givenName: string,
  folderId: string | undefined,
): Promise<string | null> {
  if (ws.name !== givenName) return "renamed";
  if (!folderId || ws.folderId !== folderId) return "moved";
  if (ws.hidden) return "hidden";
  if (deps.agentManager.getAllAgents().some((a) => a.status === "active" && a.workspacePath === ws.path)) {
    return "an agent is active";
  }
  try {
    return await deps.projectManager.worktreeRemovalRisk(projectId, ws.path);
  } catch (err) {
    return errorMessage(err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
