/**
 * Rules for linked-project groups (ADR-192) that main and the renderer both
 * apply: `electron/projects/project-groups.ts` enforces them, the sidebar's
 * "Link with…" offers only what they allow. DOM- and Node-free.
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

/** The one wording for "a group can't take a second project on this host". */
export function hostTakenMessage(
  groupName: string,
  hostLabel: string,
  takenProjectName: string,
): string {
  return `"${groupName}" already has a project on ${hostLabel} ("${takenProjectName}").`;
}
