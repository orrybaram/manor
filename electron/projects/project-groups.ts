/**
 * Linked-project groups (ADR-192): single-host projects of the same repo,
 * shown as one sidebar entry with a section per host. Members stay ordinary
 * projects — ADR-178's "one box per project" still holds — so a group is a
 * record over project ids and nothing else in `electron/projects/` reads it.
 *
 * Invariants, kept by every function here:
 * - a project belongs to at most one group;
 * - a group has at most one member per host;
 * - a group has at least two members (the last-but-one leaving dissolves it).
 */

import crypto from "node:crypto";
import type { ProjectContext } from "./context";
import type {
  PersistedProject,
  PersistedProjectGroup,
  PersistedState,
  ProjectGroupInfo,
} from "./types";

/** The group `projectId` belongs to, if any. */
export function groupOf(
  state: PersistedState,
  projectId: string,
): PersistedProjectGroup | undefined {
  return state.groups?.find((g) => g.memberIds.includes(projectId));
}

/** What the renderer sees of `projectId`'s group, or null. */
export function groupInfoFor(
  state: PersistedState,
  projectId: string,
): ProjectGroupInfo | null {
  const group = groupOf(state, projectId);
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    memberIds: [...group.memberIds],
    lastUsedHostId: group.lastUsedHostId,
  };
}

/**
 * Bring groups read from disk back in line with the invariants: drop
 * unknown or repeated members, a second member on a host already taken,
 * members claimed by an earlier group, and groups left with fewer than two
 * members. A hand-edited or stale file loads as the nearest valid state.
 */
export function normalizeGroups(state: PersistedState): void {
  if (!Array.isArray(state.groups)) {
    delete state.groups;
    return;
  }
  const byId = new Map(state.projects.map((p) => [p.id, p]));
  const claimed = new Set<string>();
  const groups: PersistedProjectGroup[] = [];
  for (const raw of state.groups as Array<Partial<PersistedProjectGroup>>) {
    if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.memberIds)) continue;
    const hosts = new Set<string>();
    const memberIds: string[] = [];
    for (const id of raw.memberIds) {
      const project = typeof id === "string" ? byId.get(id) : undefined;
      if (!project || claimed.has(project.id) || hosts.has(project.hostId)) continue;
      hosts.add(project.hostId);
      memberIds.push(project.id);
    }
    if (memberIds.length < 2) continue;
    for (const id of memberIds) claimed.add(id);
    groups.push({
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : byId.get(memberIds[0])!.name,
      memberIds,
      lastUsedHostId: typeof raw.lastUsedHostId === "string" ? raw.lastUsedHostId : null,
    });
  }
  state.groups = groups;
  if (groups.length === 0) delete state.groups;
}

function hostTaken(
  ctx: ProjectContext,
  group: PersistedProjectGroup,
  hostId: string,
  exceptProjectId?: string,
): PersistedProject | undefined {
  for (const id of group.memberIds) {
    if (id === exceptProjectId) continue;
    const member = ctx.find(id);
    if (member?.hostId === hostId) return member;
  }
  return undefined;
}

/**
 * Link `projectId` with `otherId`. When either is already in a group the
 * other joins it; otherwise a new group starts with `other` first, named
 * after it. Throws when the two are the same or unknown, sit in different
 * groups, or when the group already has a member on the joining project's
 * host. Linking two members of the same group changes nothing.
 */
export function linkProjects(
  ctx: ProjectContext,
  projectId: string,
  otherId: string,
): ProjectGroupInfo {
  const state = ctx.store.state;
  if (projectId === otherId) throw new Error("A project can't be linked with itself.");
  const project = ctx.find(projectId);
  const other = ctx.find(otherId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  if (!other) throw new Error(`Unknown project "${otherId}".`);

  const projectGroup = groupOf(state, projectId);
  const otherGroup = groupOf(state, otherId);
  if (projectGroup && otherGroup) {
    if (projectGroup === otherGroup) return groupInfoFor(state, projectId)!;
    throw new Error(
      `"${project.name}" and "${other.name}" are in different groups. Unlink one first.`,
    );
  }

  const existing = projectGroup ?? otherGroup;
  if (existing) {
    const joining = projectGroup ? other : project;
    const taken = hostTaken(ctx, existing, joining.hostId);
    if (taken) {
      throw new Error(
        `"${existing.name}" already has a project on ${ctx.hosts.label(joining.hostId)} ("${taken.name}").`,
      );
    }
    existing.memberIds.push(joining.id);
  } else {
    if (project.hostId === other.hostId) {
      throw new Error(
        `"${project.name}" and "${other.name}" are both on ${ctx.hosts.label(project.hostId)}. A group has one project per host.`,
      );
    }
    state.groups = [
      ...(state.groups ?? []),
      {
        id: crypto.randomUUID(),
        name: other.name,
        memberIds: [other.id, project.id],
        lastUsedHostId: other.hostId,
      },
    ];
  }
  ctx.store.save();
  return groupInfoFor(state, projectId)!;
}

/**
 * Take `projectId` out of its group, dissolving a group left with one
 * member. Nothing about either project — workspaces, folders, order,
 * settings — changes. An ungrouped project is a no-op.
 */
export function unlinkProject(ctx: ProjectContext, projectId: string): void {
  if (!forgetProject(ctx.store.state, projectId)) return;
  ctx.store.save();
}

/**
 * Drop `projectId` from its group without saving; true when it was in one.
 * Used by `unlinkProject` and when a project is removed.
 */
export function forgetProject(state: PersistedState, projectId: string): boolean {
  const group = groupOf(state, projectId);
  if (!group) return false;
  group.memberIds = group.memberIds.filter((id) => id !== projectId);
  if (group.memberIds.length < 2) {
    state.groups = state.groups!.filter((g) => g !== group);
  } else if (
    group.lastUsedHostId !== null &&
    !group.memberIds.some(
      (id) => state.projects.find((p) => p.id === id)?.hostId === group.lastUsedHostId,
    )
  ) {
    group.lastUsedHostId = null;
  }
  if (state.groups!.length === 0) delete state.groups;
  return true;
}

/**
 * Throws when moving `projectId` onto `hostId` would give its group two
 * members on one host (ADR-192). Called before a host switch or move.
 */
export function assertGroupHostFree(
  ctx: ProjectContext,
  projectId: string,
  hostId: string,
): void {
  const group = groupOf(ctx.store.state, projectId);
  if (!group) return;
  const taken = hostTaken(ctx, group, hostId, projectId);
  if (taken) {
    throw new Error(
      `"${group.name}" already has a project on ${ctx.hosts.label(hostId)} ("${taken.name}"). Unlink it first.`,
    );
  }
}
