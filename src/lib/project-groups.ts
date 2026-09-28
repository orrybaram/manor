/**
 * Rules for linked-project groups (ADR-192) that main and the renderer both
 * apply: `electron/projects/project-groups.ts` enforces them, the sidebar's
 * "Link with…" offers only what they allow. Which settings a group shares
 * lives here too. DOM- and Node-free.
 */

/** A project's host id, or undefined for a project not known here. */
type HostLookup = (projectId: string) => string | undefined;

/** The hosts a group's members live on — the hosts it has no room left on. */
export function groupHostIds(
  memberIds: readonly string[],
  hostOf: HostLookup,
): Set<string> {
  const hosts = new Set<string>();
  for (const id of memberIds) {
    const hostId = hostOf(id);
    if (hostId !== undefined) hosts.add(hostId);
  }
  return hosts;
}

/**
 * The member already on `hostId`, ignoring `exceptId` (a member about to
 * move), or undefined when the group has room on that host.
 */
export function memberOnHost(
  memberIds: readonly string[],
  hostId: string,
  hostOf: HostLookup,
  exceptId?: string,
): string | undefined {
  return memberIds.find((id) => id !== exceptId && hostOf(id) === hostId);
}

/** The settings a group shares across its members (ADR-192 ticket 2). */
const GROUP_SHARED_KEYS = ["name", "color", "agentCommand", "linearAssociations"] as const;

type SharedKey = (typeof GROUP_SHARED_KEYS)[number];

/**
 * Split a project update into the shared settings and the rest. A grouped
 * project's shared settings are its group's, so both `updateProject`s —
 * main's and the renderer store's — send them there instead.
 */
export function splitShared<U extends object>(
  updates: U,
): { shared: Pick<U, Extract<keyof U, SharedKey>>; own: Omit<U, SharedKey> } {
  const shared: Record<string, unknown> = {};
  const own = { ...updates } as Record<string, unknown>;
  for (const key of GROUP_SHARED_KEYS) {
    if (!(key in own)) continue;
    shared[key] = own[key];
    delete own[key];
  }
  return {
    shared: shared as Pick<U, Extract<keyof U, SharedKey>>,
    own: own as Omit<U, SharedKey>,
  };
}

/** The one wording for "no member of this group is on that host". */
export function noMemberOnHostMessage(groupName: string, hostLabel: string): string {
  return `"${groupName}" has no project on ${hostLabel}.`;
}

/** The one wording for "a group can't take a second project on this host". */
export function hostTakenMessage(
  groupName: string,
  hostLabel: string,
  takenProjectName: string,
): string {
  return `"${groupName}" already has a project on ${hostLabel} ("${takenProjectName}").`;
}
