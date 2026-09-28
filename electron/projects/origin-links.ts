/**
 * Link suggestions by git `origin` (ADR-192 ticket 5). When two projects on
 * different hosts are clones of the same repo, Manor offers to link them,
 * and the user confirms. Nothing here links: `suggest` only lists
 * candidates, and linking goes through `project-groups.ts` as it would from
 * the sidebar.
 *
 * - A repo's identity is its normalized `origin` URL (`originKey`).
 * - A group remembers the key of its first member that has one
 *   (`PersistedProjectGroup.originUrl`), so it can still be matched while
 *   the hosts of all its members are away.
 * - A suggestion the user dismissed is remembered as the pair of project ids
 *   (`PersistedState.dismissedLinkSuggestions`), and not offered again. The
 *   key is absent until the first dismissal, so files of users who never
 *   dismiss are written back unchanged.
 */

import { ghRepoFromRemoteUrl } from "../github";
import { memberOnHost } from "../../src/lib/project-groups";
import type { ProjectContext } from "./context";
import { groupOf } from "./project-groups";
import { normalizeOriginUrl } from "./remote-clone";
import type {
  LinkSuggestion,
  PersistedProject,
  PersistedProjectGroup,
  PersistedState,
} from "./types";

/**
 * A repo's identity from a git remote URL: `host/owner/repo`, lower-cased,
 * so the https, `ssh://` and scp-style forms of one repo compare equal. The
 * GitHub remote parsing reads `[HOST/]OWNER/REPO` URLs; any other remote
 * falls back to `normalizeOriginUrl`. Null for no URL, and for a remote
 * that is only a path on disk (`/srv/git/app`, `../app`, `file://…`), which
 * names a different directory on each host rather than one repo.
 */
export function originKey(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  const repo = ghRepoFromRemoteUrl(trimmed);
  if (repo) {
    // `ghRepoFromRemoteUrl` leaves github.com out of the slug; put it back
    // so a GitHub repo and one on another host never share a key.
    return (repo.split("/").length === 2 ? `github.com/${repo}` : repo).toLowerCase();
  }
  if (/^file:/i.test(trimmed)) return null;
  const key = normalizeOriginUrl(trimmed);
  return /^[^/.~][^/]*\/[^/]/.test(key) ? key : null;
}

/** The two ids of a dismissed pair, in a fixed order so either side finds it. */
function pairOf(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function isDismissed(state: PersistedState, a: string, b: string): boolean {
  const [x, y] = pairOf(a, b);
  return state.dismissedLinkSuggestions?.some(([p, q]) => p === x && q === y) ?? false;
}

/**
 * Bring dismissed pairs read from disk back in line: drop malformed ones,
 * ones naming a project that no longer exists, and repeats; drop the key
 * when nothing is left.
 */
export function normalizeLinkDismissals(state: PersistedState): void {
  const raw: unknown = state.dismissedLinkSuggestions;
  const known = new Set(state.projects.map((p) => p.id));
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [a, b] = entry as unknown[];
      if (typeof a !== "string" || typeof b !== "string" || a === b) continue;
      if (!known.has(a) || !known.has(b)) continue;
      const pair = pairOf(a, b);
      if (!pairs.some(([p, q]) => p === pair[0] && q === pair[1])) pairs.push(pair);
    }
  }
  if (pairs.length > 0) state.dismissedLinkSuggestions = pairs;
  else delete state.dismissedLinkSuggestions;
}

/**
 * Forget every dismissed pair naming `projectId`, without saving; true when
 * there was one. Used when a project is removed.
 */
export function forgetLinkDismissals(state: PersistedState, projectId: string): boolean {
  const pairs = state.dismissedLinkSuggestions;
  if (!pairs) return false;
  const kept = pairs.filter(([a, b]) => a !== projectId && b !== projectId);
  if (kept.length === pairs.length) return false;
  if (kept.length > 0) state.dismissedLinkSuggestions = kept;
  else delete state.dismissedLinkSuggestions;
  return true;
}

/**
 * Finds link candidates by `origin`, remembers dismissals and records a
 * group's `origin`. Each checkout's key is cached once its host has answered;
 * a host that is away or a repo without an `origin` is asked again next time.
 */
export class OriginLinks {
  private readonly keys = new Map<string, string>();

  constructor(private readonly ctx: ProjectContext) {}

  /**
   * Candidates to link `projectId` with: projects on another host, or groups
   * with no member on its host, whose `origin` matches its own. A group is
   * offered once, under its first member. When `projectId` is itself in a
   * group, only ungrouped projects on a host the group lacks are offered,
   * since two groups can't be linked. Dismissed pairs are left out. Nothing
   * is linked.
   */
  async suggest(projectId: string): Promise<LinkSuggestion[]> {
    const state = this.ctx.store.state;
    const project = this.ctx.find(projectId);
    if (!project) return [];
    const ownGroup = groupOf(state, projectId);
    const key = (await this.keyOf(project)) ?? ownGroup?.originUrl ?? null;
    if (!key) return [];

    const hostOf = (id: string) => this.ctx.find(id)?.hostId;
    const ownHosts = new Set(ownGroup ? ownGroup.memberIds.map(hostOf) : [project.hostId]);
    const lone: PersistedProject[] = [];
    const grouped = new Map<string, PersistedProjectGroup>();
    for (const other of state.projects) {
      if (other.id === projectId) continue;
      const otherGroup = groupOf(state, other.id);
      if (otherGroup) {
        // Two groups can't be linked, and a group is offered only once.
        if (ownGroup || grouped.has(otherGroup.id)) continue;
        if (memberOnHost(otherGroup.memberIds, project.hostId, hostOf) !== undefined) continue;
        if (otherGroup.memberIds.some((id) => isDismissed(state, projectId, id))) continue;
        grouped.set(otherGroup.id, otherGroup);
      } else if (!ownHosts.has(other.hostId) && !isDismissed(state, projectId, other.id)) {
        lone.push(other);
      }
    }

    const [loneKeys, groupKeys] = await Promise.all([
      Promise.all(lone.map((p) => this.keyOf(p))),
      Promise.all([...grouped.values()].map((g) => this.groupKey(g))),
    ]);
    const suggestions: LinkSuggestion[] = [];
    [...grouped.values()].forEach((group, i) => {
      if (groupKeys[i] !== key) return;
      const members = group.memberIds
        .map((id) => this.ctx.find(id))
        .filter((p): p is PersistedProject => p !== undefined);
      suggestions.push({
        projectId: members[0].id,
        name: group.name,
        hostId: members[0].hostId,
        hostLabel: members.map((p) => this.ctx.hosts.label(p.hostId)).join(", "),
        groupId: group.id,
      });
    });
    lone.forEach((other, i) => {
      if (loneKeys[i] !== key) return;
      suggestions.push({
        projectId: other.id,
        name: other.name,
        hostId: other.hostId,
        hostLabel: this.ctx.hosts.label(other.hostId),
        groupId: null,
      });
    });
    return suggestions;
  }

  /**
   * Don't suggest linking `projectId` with `otherId` again — nor with
   * `otherId`'s group, which is offered under its members' ids.
   */
  dismiss(projectId: string, otherId: string): void {
    if (projectId === otherId) return;
    if (!this.ctx.find(projectId) || !this.ctx.find(otherId)) return;
    const state = this.ctx.store.state;
    if (isDismissed(state, projectId, otherId)) return;
    state.dismissedLinkSuggestions = [
      ...(state.dismissedLinkSuggestions ?? []),
      pairOf(projectId, otherId),
    ];
    this.ctx.store.save();
  }

  /**
   * Record `groupId`'s `origin` key if it has none yet: that of its first
   * member whose host can say. Never rejects; a group whose hosts are all
   * away is left without one, to be filled in by a later `suggest`.
   */
  async rememberGroupOrigin(groupId: string): Promise<void> {
    const group = this.ctx.store.state.groups?.find((g) => g.id === groupId);
    if (!group || group.originUrl) return;
    await this.groupKey(group);
  }

  /**
   * A group's `origin` key: the one it stored, or else its first member's
   * that a host reports, which is then stored.
   */
  private async groupKey(group: PersistedProjectGroup): Promise<string | null> {
    if (group.originUrl) return group.originUrl;
    for (const id of group.memberIds) {
      const member = this.ctx.find(id);
      const key = member ? await this.keyOf(member) : null;
      if (!key) continue;
      // The group may have been dissolved, or given a key, while git ran.
      if (!group.originUrl && this.ctx.store.state.groups?.includes(group)) {
        group.originUrl = key;
        this.ctx.store.save();
      }
      return group.originUrl ?? key;
    }
    return null;
  }

  /** `project`'s `origin` key, from its host's git; null when that fails. */
  private async keyOf(project: PersistedProject): Promise<string | null> {
    // By checkout rather than project id: a project moved to another host
    // is a different clone, which is asked afresh.
    const checkout = `${project.hostId}\0${project.path}`;
    const cached = this.keys.get(checkout);
    if (cached) return cached;
    try {
      const out = await this.ctx
        .host(project.hostId)
        .git.exec(project.path, ["remote", "get-url", "origin"]);
      const key = originKey(out);
      if (key) this.keys.set(checkout, key);
      return key;
    } catch {
      return null;
    }
  }
}
