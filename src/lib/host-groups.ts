/**
 * Grouping a profile's hosts (ADR-235 D7): hosts made from one profile list
 * together, under its name, with "N of M running".
 */

/** The slice of a host this needs. */
export interface GroupableHost {
  hostId: string;
  profileId?: string;
  status: string;
}

export interface HostGroup<H extends GroupableHost, P extends { id: string }> {
  profile: P;
  hosts: H[];
  /** Hosts that are connected. */
  running: number;
  total: number;
}

export interface HostGroups<H extends GroupableHost, P extends { id: string }> {
  /** One per profile that has at least one host, in profile order. */
  groups: HostGroup<H, P>[];
  /** Hosts with no profile, or one that no longer exists. */
  rest: H[];
  /** Grouped hosts in `error`: surfaced on their own as well. */
  errored: H[];
}

/** Whether a host is up. Only `connected` is: the rest are away or on the way. */
export function isHostRunning(host: GroupableHost): boolean {
  return host.status === "connected";
}

/** "2 of 3 running". */
export function runningSummary(group: { running: number; total: number }): string {
  return `${group.running} of ${group.total} running`;
}

export function groupHostsByProfile<H extends GroupableHost, P extends { id: string }>(
  hosts: H[],
  profiles: P[],
): HostGroups<H, P> {
  const byProfile = new Map<string, H[]>();
  const known = new Set(profiles.map((p) => p.id));
  const rest: H[] = [];
  for (const host of hosts) {
    if (host.profileId && known.has(host.profileId)) {
      const list = byProfile.get(host.profileId) ?? [];
      list.push(host);
      byProfile.set(host.profileId, list);
    } else {
      rest.push(host);
    }
  }
  const groups: HostGroup<H, P>[] = [];
  const errored: H[] = [];
  for (const profile of profiles) {
    const list = byProfile.get(profile.id);
    if (!list) continue;
    groups.push({
      profile,
      hosts: list,
      running: list.filter(isHostRunning).length,
      total: list.length,
    });
    errored.push(...list.filter((h) => h.status === "error"));
  }
  return { groups, rest, errored };
}
