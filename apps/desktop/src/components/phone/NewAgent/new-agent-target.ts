import type { HostStatusInfo } from "../../../store/host-store";
import type { ProjectInfo } from "../../../store/project-store";
import { find } from "../../../lib/workspace-directory";
import { normalizeHostId, type WorkspaceKey } from "../../../lib/workspace-key";
import { startingMemberId } from "../../../lib/workspace-host-choices";
import { branchesEqual } from "../../../utils/branch-name";
import { buildTopLevelEntries, type TopLevelEntry } from "../../../utils/sidebar-items";

/** Where the phone new-agent composer will start its agent. */
export type NewAgentTarget = {
  projectId: string;
  workspacePath: string;
  newWorktree: boolean;
};

/*
 * The target model: pure functions over the project list, so the
 * composer's chips and the launch read the same decisions. A target names a
 * member project (never a group), so "which host" is already in `projectId`.
 */

/** The slice of a project the model reads; `ProjectInfo` fits as is. */
type TargetProject = Pick<
  ProjectInfo,
  "id" | "name" | "path" | "hostId" | "color" | "defaultBranch" | "workspaces" | "folders" | "sidebarOrder" | "group"
>;

/** One entry in the project chip: a lone project, or a linked group collapsed to one. */
export interface ProjectChoice {
  /** The project id, or the group id for a linked group. */
  id: string;
  name: string;
  color: string | null;
  /** A linked group: `id` is the group's, so it is checked by group, not project. */
  isGroup: boolean;
}

/** One entry in the workspace chip. */
export interface WorkspaceChoice {
  path: string;
  label: string;
  branch: string;
  isMain: boolean;
}

/** A target resolved against the current project list. */
export interface ResolvedTarget<P extends TargetProject = TargetProject> {
  project: P;
  workspace: WorkspaceChoice;
  hostId: string;
}

/** The member project an entry starts on: a lone project, or a group's `startingMemberId`. */
function entryMemberId<P extends TargetProject>(
  entry: TopLevelEntry<P>,
  projects: readonly P[],
  hosts: readonly HostStatusInfo[],
): string {
  if (entry.kind === "project") return entry.project.id;
  return startingMemberId(entry.sections[0].project.id, projects, hosts);
}

/** The target at `project`'s main checkout. */
function mainTarget(projectId: string, projects: readonly TargetProject[], newWorktree: boolean): NewAgentTarget | null {
  const project = projects.find((p) => p.id === projectId);
  return project ? { projectId: project.id, workspacePath: project.path, newWorktree } : null;
}

/**
 * Where a fresh composer starts: the active workspace, else the first
 * project (a group resolves through its starting member) at its main
 * checkout. Null when there are no projects.
 */
export function seedTarget(
  projects: readonly TargetProject[],
  activeKey: WorkspaceKey | null,
  hosts: readonly HostStatusInfo[],
): NewAgentTarget | null {
  const active = activeKey ? find(projects, activeKey) : undefined;
  if (active) {
    return { projectId: active.project.id, workspacePath: active.workspace.path, newWorktree: false };
  }
  const first = buildTopLevelEntries(projects)[0];
  if (!first) return null;
  return mainTarget(entryMemberId(first, projects, hosts), projects, false);
}

/** One choice per top-level entry, a linked group standing for all its members. */
export function projectChoices(projects: readonly TargetProject[]): ProjectChoice[] {
  return buildTopLevelEntries(projects).map((entry) =>
    entry.kind === "project"
      ? { id: entry.project.id, name: entry.project.name, color: entry.project.color, isGroup: false }
      : { id: entry.group.id, name: entry.group.name, color: entry.sections[0].project.color, isGroup: true },
  );
}

/** The main checkout's choice for `project`, whether or not it lists itself. */
function mainChoice(project: TargetProject): WorkspaceChoice {
  const listed = project.workspaces.find((w) => w.isMain);
  const branch = listed?.branch ?? project.defaultBranch;
  return { path: project.path, label: listed?.name ?? (project.defaultBranch || "main"), branch, isMain: true };
}

/** Main first, then the project's visible workspaces in project order. */
export function workspaceChoices(target: NewAgentTarget, projects: readonly TargetProject[]): WorkspaceChoice[] {
  const project = projects.find((p) => p.id === target.projectId);
  if (!project) return [];
  const rest = project.workspaces
    .filter((w) => !w.isMain && !w.hidden && w.path !== project.path)
    .map((w) => ({ path: w.path, label: w.name ?? w.branch, branch: w.branch, isMain: false }));
  return [mainChoice(project), ...rest];
}

/** Move to another project or group: its starting member, at main. Keeps `newWorktree`. */
export function selectProject(
  target: NewAgentTarget,
  idOrGroupId: string,
  projects: readonly TargetProject[],
  hosts: readonly HostStatusInfo[],
): NewAgentTarget {
  const entry = buildTopLevelEntries(projects).find((e) => e.key === idOrGroupId);
  if (!entry) return target;
  return mainTarget(entryMemberId(entry, projects, hosts), projects, target.newWorktree) ?? target;
}

/** Move to another member of the linked group, staying on the same branch when it has one. */
export function selectHost(
  target: NewAgentTarget,
  memberProjectId: string,
  projects: readonly TargetProject[],
): NewAgentTarget {
  const next = projects.find((p) => p.id === memberProjectId);
  if (!next || next.id === target.projectId) return target;
  const current = workspaceChoices(target, projects).find((w) => w.path === target.workspacePath);
  const sameBranch = current
    ? next.workspaces.find((w) => !w.hidden && branchesEqual(w.branch, current.branch))
    : undefined;
  return {
    projectId: next.id,
    workspacePath: sameBranch?.path ?? next.path,
    newWorktree: target.newWorktree,
  };
}

/**
 * The target against the current project list, or null once it went stale (its
 * project or workspace was removed); the caller then re-seeds.
 */
export function resolveTarget<P extends TargetProject>(
  target: NewAgentTarget,
  projects: readonly P[],
): ResolvedTarget<P> | null {
  const project = projects.find((p) => p.id === target.projectId);
  if (!project) return null;
  const workspace = workspaceChoices(target, projects).find((w) => w.path === target.workspacePath);
  if (!workspace) return null;
  return { project, workspace, hostId: normalizeHostId(project.hostId) };
}

/**
 * The branch a new worktree off `resolved` starts from: main bases off the
 * project's default branch, as NewWorkspaceDialog does (left unset, main
 * would try `origin/<default>`, which a repo with no remote doesn't have);
 * another workspace off its own branch. Undefined for a workspace with no
 * branch (a detached HEAD), so creation falls back to `origin/<default>`.
 * The composer's sentence and the send both read it.
 */
export function baseBranchOf(resolved: Pick<ResolvedTarget, "project" | "workspace">): string | undefined {
  const { project, workspace } = resolved;
  return workspace.isMain ? project.defaultBranch || "main" : workspace.branch || undefined;
}
