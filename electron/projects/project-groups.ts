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
 *
 * A group also holds the settings its members share (ticket 2; theme and
 * commands joined in ADR-193 ticket 1): name, color, agent command, Linear
 * association, theme and custom commands. Reads resolve group first, then
 * project (`resolveShared`); a project leaving takes the group's values
 * with it, so it keeps its look (`copySharedOnto`).
 */

import crypto from "node:crypto";
import {
  hostTakenMessage,
  memberOnHost,
  noMemberOnHostMessage,
} from "../../src/lib/project-groups";
import { isCustomCommand, isLinearAssociation } from "../ipc-validate";
import type { ProjectContext } from "./context";
import type {
  GroupSharedFields,
  GroupUpdatableFields,
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
  return group ? summarizeGroup(group) : null;
}

/** What the renderer sees of `group`. */
export function summarizeGroup(group: PersistedProjectGroup): ProjectGroupInfo {
  return {
    id: group.id,
    name: group.name,
    memberIds: [...group.memberIds],
    lastUsedHostId: group.lastUsedHostId,
  };
}

/**
 * `project`'s shared settings as the renderer sees them: the group's value
 * where the group has one, else the project's own. A null on the group is a
 * value ("no color"), not a fall-through; only an absent one falls through.
 */
export function resolveShared(
  group: PersistedProjectGroup | undefined,
  project: PersistedProject,
): GroupSharedFields {
  return {
    name: group?.name ?? project.name,
    color: (group?.color !== undefined ? group.color : project.color) ?? null,
    agentCommand:
      (group?.agentCommand !== undefined ? group.agentCommand : project.agentCommand) ??
      null,
    linearAssociations: group?.linearAssociations ?? project.linearAssociations ?? [],
    themeName:
      (group?.themeName !== undefined ? group.themeName : project.themeName) ?? null,
    commands: group?.commands ?? project.commands ?? [],
  };
}

/** The shared settings a group read from disk actually has, type-checked. */
function sharedFrom(
  raw: Partial<PersistedProjectGroup>,
): Pick<
  PersistedProjectGroup,
  "color" | "agentCommand" | "linearAssociations" | "themeName" | "commands"
> {
  const out: Pick<
    PersistedProjectGroup,
    "color" | "agentCommand" | "linearAssociations" | "themeName" | "commands"
  > = {};
  if (raw.color === null || typeof raw.color === "string") out.color = raw.color;
  if (raw.agentCommand === null || typeof raw.agentCommand === "string") {
    out.agentCommand = raw.agentCommand;
  }
  if (raw.themeName === null || typeof raw.themeName === "string") {
    out.themeName = raw.themeName;
  }
  if (Array.isArray(raw.linearAssociations)) {
    // A malformed entry would break every later read of `teamId`.
    out.linearAssociations = raw.linearAssociations.filter(isLinearAssociation);
  }
  if (Array.isArray(raw.commands)) {
    // A malformed entry would break every later read of `id`/`name`/`command`.
    out.commands = raw.commands.filter(isCustomCommand);
  }
  return out;
}

/**
 * Bring groups read from disk back in line with the invariants: drop
 * unknown or repeated members, a second member on a host already taken,
 * members claimed by an earlier group, and groups left with fewer than two
 * members, and a `lastUsedHostId` no member is on any more. A hand-edited
 * or stale file loads as the nearest valid state. A group dropped for
 * having one member left dissolves as an unlink would: that member keeps
 * the group's shared settings.
 */
export function normalizeGroups(state: PersistedState): void {
  if (!Array.isArray(state.groups)) {
    delete state.groups;
    return;
  }
  const byId = new Map(state.projects.map((p) => [p.id, p]));
  const claimed = new Set<string>();
  const groups: PersistedProjectGroup[] = [];
  const dissolved: PersistedProjectGroup[] = [];
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
    const shared = sharedFrom(raw);
    if (memberIds.length < 2) {
      if (memberIds.length === 1 && typeof raw.name === "string") {
        dissolved.push({ ...shared, id: raw.id, name: raw.name, memberIds, lastUsedHostId: null });
      }
      continue;
    }
    for (const id of memberIds) claimed.add(id);
    const lastUsed = raw.lastUsedHostId;
    groups.push({
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : byId.get(memberIds[0])!.name,
      memberIds,
      lastUsedHostId: typeof lastUsed === "string" && hosts.has(lastUsed) ? lastUsed : null,
      ...shared,
      ...(typeof raw.originKey === "string" && raw.originKey !== ""
        ? { originKey: raw.originKey }
        : {}),
    });
  }
  // After the loop: a later group may still have claimed the survivor.
  for (const group of dissolved) {
    const survivor = byId.get(group.memberIds[0]);
    if (survivor && !claimed.has(survivor.id)) copySharedOnto(group, survivor);
  }
  state.groups = groups;
  if (groups.length === 0) delete state.groups;
}

/** Throws when `group` already has a member on `hostId` other than `exceptId`. */
function assertRoomOnHost(
  ctx: ProjectContext,
  group: PersistedProjectGroup,
  hostId: string,
  exceptId?: string,
): void {
  const takenId = memberOnHost(
    group.memberIds,
    hostId,
    (id) => ctx.find(id)?.hostId,
    exceptId,
  );
  if (takenId === undefined) return;
  const taken = ctx.find(takenId);
  throw new Error(
    hostTakenMessage(group.name, ctx.hosts.label(hostId), taken?.name ?? takenId),
  );
}

/**
 * Link `projectId` with `otherId`. When either is already in a group the
 * other joins it; otherwise a new group starts with `other` first, named
 * after it and taking its shared settings. Throws when the two are the same or unknown, sit in different
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
    assertRoomOnHost(ctx, existing, joining.hostId);
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
        color: other.color ?? null,
        agentCommand: other.agentCommand ?? null,
        linearAssociations: [...(other.linearAssociations ?? [])],
        themeName: other.themeName ?? null,
        commands: [...(other.commands ?? [])],
      },
    ];
  }
  ctx.store.save();
  return groupInfoFor(state, projectId)!;
}

/**
 * Set a group's shared settings; its members show them from now on. Throws
 * on an unknown group. A blank name is ignored — a group always has one.
 */
export function updateGroup(
  ctx: ProjectContext,
  groupId: string,
  updates: GroupUpdatableFields,
): PersistedProjectGroup {
  const group = ctx.store.state.groups?.find((g) => g.id === groupId);
  if (!group) throw new Error(`Unknown group "${groupId}".`);
  const name = updates.name?.trim();
  if (name) group.name = name;
  if (updates.color !== undefined) group.color = updates.color;
  if (updates.agentCommand !== undefined) group.agentCommand = updates.agentCommand;
  if (updates.themeName !== undefined) group.themeName = updates.themeName;
  if (updates.linearAssociations !== undefined) {
    group.linearAssociations = [...updates.linearAssociations];
  }
  if (updates.commands !== undefined) {
    group.commands = [...updates.commands];
  }
  ctx.store.save();
  return group;
}

/**
 * Give `project` the group's shared settings as its own, so that once it
 * is out of the group it still looks the way it did in it. A setting the
 * group never had leaves the project's own value in place.
 */
function copySharedOnto(group: PersistedProjectGroup, project: PersistedProject): void {
  project.name = group.name;
  if (group.color !== undefined) project.color = group.color;
  if (group.agentCommand !== undefined) project.agentCommand = group.agentCommand;
  if (group.themeName !== undefined) project.themeName = group.themeName;
  if (group.linearAssociations !== undefined) {
    project.linearAssociations = [...group.linearAssociations];
  }
  if (group.commands !== undefined) {
    project.commands = [...group.commands];
  }
}

/**
 * Remember `hostId` as the host `groupId` last made a workspace on, so the
 * New Workspace host picker starts there next time. Throws for an unknown
 * group or a host none of its members is on; the same host again is a no-op.
 */
export function setGroupLastUsedHost(
  ctx: ProjectContext,
  groupId: string,
  hostId: string,
): void {
  const group = ctx.store.state.groups?.find((g) => g.id === groupId);
  if (!group) throw new Error(`Unknown project group "${groupId}".`);
  if (group.lastUsedHostId === hostId) return;
  if (memberOnHost(group.memberIds, hostId, (id) => ctx.find(id)?.hostId) === undefined) {
    throw new Error(noMemberOnHostMessage(group.name, ctx.hosts.label(hostId)));
  }
  group.lastUsedHostId = hostId;
  ctx.store.save();
}

/**
 * Take `projectId` out of its group, dissolving a group left with one
 * member. The project leaving — and the last member of a dissolved group —
 * takes the group's shared settings with it; its workspaces, folders and
 * order are untouched. An ungrouped project is a no-op.
 */
export function unlinkProject(ctx: ProjectContext, projectId: string): void {
  if (!forgetProject(ctx.store.state, projectId)) return;
  ctx.store.save();
}

/**
 * Dissolve a whole group: every member becomes an ordinary unlinked
 * project again, keeping the group's shared settings as its own and
 * nothing else changed. An unknown id is a no-op.
 */
export function unlinkGroup(ctx: ProjectContext, groupId: string): void {
  const state = ctx.store.state;
  const group = state.groups?.find((g) => g.id === groupId);
  if (!group || !state.groups) return;
  for (const id of group.memberIds) {
    const member = ctx.find(id);
    if (member) copySharedOnto(group, member);
  }
  state.groups = state.groups.filter((g) => g.id !== groupId);
  if (state.groups.length === 0) delete state.groups;
  ctx.store.save();
}

/**
 * Drop `projectId` from its group without saving; true when it was in one.
 * The project leaving, and the last member of a group it dissolves, keep
 * the group's shared settings. Used by `unlinkProject` and when a project
 * is removed.
 */
export function forgetProject(state: PersistedState, projectId: string): boolean {
  const group = groupOf(state, projectId);
  if (!group) return false;
  const byId = (id: string) => state.projects.find((p) => p.id === id);
  const leaving = byId(projectId);
  if (leaving) copySharedOnto(group, leaving);
  group.memberIds = group.memberIds.filter((id) => id !== projectId);
  // The origin key may have come from the member that left (ticket 5); the
  // caller derives it again from the rest.
  delete group.originKey;
  if (group.memberIds.length < 2) {
    for (const id of group.memberIds) {
      const last = byId(id);
      if (last) copySharedOnto(group, last);
    }
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
  assertRoomOnHost(ctx, group, hostId, projectId);
}
