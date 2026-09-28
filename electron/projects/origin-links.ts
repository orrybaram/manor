/**
 * Link suggestions by git `origin` (ADR-192 ticket 5). When two projects on
 * different hosts are clones of the same repo, Manor offers to link them,
 * and the user confirms. Nothing here links: `suggest` only lists
 * candidates, and linking goes through `project-groups.ts` as it would from
 * the sidebar.
 *
 * - A repo's identity is its normalized `origin` URL (`originKey`).
 * - A group remembers the key of the first of its current members that
 *   reported one (`PersistedProjectGroup.originKey`), so it can still be
 *   matched while the hosts of all its members are away. A member leaving
 *   clears it, and it is derived again from the members that remain.
 * - A suggestion the user dismissed is remembered as the pair of project ids
 *   (`PersistedState.dismissedLinkSuggestions`), and not offered again. The
 *   key is absent until the first dismissal, so files of users who never
 *   dismiss are written back unchanged.
 */

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

/** A remote URL with a scheme (`https://`, `ssh://`, `git://`, …). */
const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\//i;
/**
 * An scp-style remote, `[user@]host:path`. The host must be longer than one
 * character, so a Windows drive (`C:/x`, `C:\x`) isn't read as one.
 */
const SCP_URL = /^(?:[^@/\\]+@)?[^@/:\\]{2,}:/;

/**
 * A repo's identity from a git remote URL: `normalizeOriginUrl`'s
 * `host/path`, so the https, `ssh://` and scp-style forms of one repo compare
 * equal. Null for no URL, and for a remote that is only a path on disk
 * (`/srv/git/app`, `../app`, `repos/app`, `C:/x`, `file://…`), which names
 * a different directory on each host rather than one repo.
 */
export function originKey(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  const scheme = SCHEME_URL.exec(trimmed);
  const isRemote = scheme ? scheme[1].toLowerCase() !== "file" : SCP_URL.test(trimmed);
  if (!isRemote) return null;
  const key = normalizeOriginUrl(trimmed);
  return /^[^/]+\/[^/]/.test(key) ? key : null;
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
 * One project or group that might be offered: what to show, and how to
 * find its `origin` key.
 */
interface Candidate {
  suggestion: LinkSuggestion;
  key: () => Promise<string | null>;
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
   * Candidates to link `projectId` with, whose `origin` matches its own.
   * Nothing is linked. See `candidatesFor` for which are considered.
   */
  async suggest(projectId: string): Promise<LinkSuggestion[]> {
    const project = this.ctx.find(projectId);
    if (!project) return [];
    const ownGroup = groupOf(this.ctx.store.state, projectId);
    const key = (await this.keyOf(project)) ?? (ownGroup ? await this.groupKey(ownGroup) : null);
    if (!key) return [];

    const candidates = this.candidatesFor(project, ownGroup);
    const keyed = await Promise.all(
      candidates.map(async (candidate) => ({ candidate, key: await candidate.key() })),
    );
    return keyed.filter((c) => c.key === key).map((c) => c.candidate.suggestion);
  }

  /**
   * What `project` could be linked with: projects on another host, and
   * groups with no member on its host, each group once, under its first
   * member. When `project` is itself in a group, only ungrouped projects on
   * a host that group lacks, since two groups can't be linked. Dismissed
   * pairs are left out; a dismissal with any member of a group covers it.
   */
  private candidatesFor(
    project: PersistedProject,
    ownGroup: PersistedProjectGroup | undefined,
  ): Candidate[] {
    const state = this.ctx.store.state;
    const hostOf = (id: string) => this.ctx.find(id)?.hostId;
    const ownHosts = new Set(ownGroup ? ownGroup.memberIds.map(hostOf) : [project.hostId]);
    const seenGroups = new Set<string>();
    const candidates: Candidate[] = [];
    for (const other of state.projects) {
      if (other.id === project.id) continue;
      const group = groupOf(state, other.id);
      if (!group) {
        if (ownHosts.has(other.hostId) || isDismissed(state, project.id, other.id)) continue;
        candidates.push({
          suggestion: {
            projectId: other.id,
            name: other.name,
            hostLabel: this.ctx.hosts.label(other.hostId),
          },
          key: () => this.keyOf(other),
        });
        continue;
      }
      if (ownGroup || seenGroups.has(group.id)) continue;
      seenGroups.add(group.id);
      if (memberOnHost(group.memberIds, project.hostId, hostOf) !== undefined) continue;
      if (group.memberIds.some((id) => isDismissed(state, project.id, id))) continue;
      const hostLabels = group.memberIds.flatMap((id) => {
        const hostId = hostOf(id);
        return hostId === undefined ? [] : [this.ctx.hosts.label(hostId)];
      });
      candidates.push({
        suggestion: {
          projectId: group.memberIds[0],
          name: group.name,
          hostLabel: hostLabels.join(", "),
        },
        key: () => this.groupKey(group),
      });
    }
    return candidates;
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
   * Record `groupId`'s `origin` key if it has none: that of its first member
   * whose host can say. Called after linking and after a member leaves.
   * Never rejects; a group whose hosts are all away is left without one, to
   * be filled in by a later `suggest`.
   */
  async rememberGroupOrigin(groupId: string): Promise<void> {
    const group = this.ctx.store.state.groups?.find((g) => g.id === groupId);
    if (!group || group.originKey) return;
    await this.groupKey(group);
  }

  /**
   * A group's `origin` key: the one it stored, or else its first member's
   * that a host reports, which is then stored.
   */
  private async groupKey(group: PersistedProjectGroup): Promise<string | null> {
    if (group.originKey) return group.originKey;
    for (const id of [...group.memberIds]) {
      const member = this.ctx.find(id);
      const key = member ? await this.keyOf(member) : null;
      if (!key) continue;
      // While git ran, the group may have been dissolved, given a key, or
      // lost this member — whose key would then be stale.
      if (
        !group.originKey &&
        group.memberIds.includes(id) &&
        this.ctx.store.state.groups?.includes(group)
      ) {
        group.originKey = key;
        this.ctx.store.save();
      }
      return group.originKey ?? key;
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
