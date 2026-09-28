import { useHostStore } from "./host-store";
import { useToastStore } from "./toast-store";

/** Mirrors `LinkSuggestion` in `electron/projects/types.ts` (ADR-192 ticket 5). */
export interface LinkSuggestion {
  /** The project to link with: a lone project, or a group's first member. */
  projectId: string;
  /** The project's name, or its group's. */
  name: string;
  /** Where it lives: its host's label, or a group's hosts' labels. */
  hostLabel: string;
}

type LinkProjects = (projectId: string, otherId: string) => Promise<void>;

/** What `startLinkSuggestions` needs of each loaded project. */
interface LoadedProject {
  id: string;
  hostId: string;
  group?: { id: string } | null;
}

/**
 * Every pair offered this session, by toast id. A pair is offered at most
 * once per session, and a link clears the open toasts naming its projects.
 */
const offered = new Map<string, readonly [string, string]>();

/** Stops the current session's host watch; see `startLinkSuggestions`. */
let stopWatchingHosts: (() => void) | null = null;

/**
 * The toast id of one suggested pair, the same from either side, so a pair
 * is offered in at most one toast and asking again replaces it.
 */
export function linkSuggestionToastId(projectId: string, otherId: string): string {
  const [a, b] = projectId < otherId ? [projectId, otherId] : [otherId, projectId];
  return `link-suggestion-${a}-${b}`;
}

/** One toast asking to link `projectId` with `suggestion`. */
function showSuggestion(
  projectId: string,
  suggestion: LinkSuggestion,
  link: LinkProjects,
): void {
  const { addToast, removeToast } = useToastStore.getState();
  const id = linkSuggestionToastId(projectId, suggestion.projectId);
  offered.set(id, [projectId, suggestion.projectId]);
  addToast({
    id,
    status: "info",
    persistent: true,
    message: `Link with "${suggestion.name}" on ${suggestion.hostLabel}?`,
    detail: "It's a clone of the same repo. Linked projects share one sidebar entry.",
    action: {
      label: "Link",
      onClick: () => {
        removeToast(id);
        void link(projectId, suggestion.projectId);
      },
    },
    secondaryAction: {
      label: "Dismiss",
      onClick: () => {
        removeToast(id);
        window.electronAPI.projects
          .dismissLinkSuggestion(projectId, suggestion.projectId)
          .catch(() => {
            /* not remembered; it may be offered again next time */
          });
      },
    },
  });
}

/** Main's suggestions for `projectId`; none when the lookup fails. */
async function suggestionsFor(projectId: string): Promise<LinkSuggestion[]> {
  try {
    return await window.electronAPI.projects.suggestLinks(projectId);
  } catch {
    return [];
  }
}

/**
 * After `projectId` is added or cloned, offer to link it with each project
 * or group on another host that has the same `origin` (ADR-192 ticket 5).
 * Each offer is a toast: "Link" calls `link`, "Dismiss" asks main not to
 * suggest the pair again, and closing it just hides it. Nothing is linked
 * without the user's click, a failed lookup shows nothing, and a pair
 * already offered this session isn't offered again.
 */
export async function offerLinkSuggestions(
  projectId: string,
  link: LinkProjects,
): Promise<void> {
  await offerForEach([{ id: projectId }], link);
}

/**
 * Offer each project's suggestions in turn, skipping pairs already offered
 * this session. One project at a time, so each host is asked for each
 * checkout's `origin` once. Dismissed pairs never come back from main.
 */
async function offerForEach(
  projects: readonly { id: string }[],
  link: LinkProjects,
): Promise<void> {
  for (const project of projects) {
    for (const suggestion of await suggestionsFor(project.id)) {
      if (offered.has(linkSuggestionToastId(project.id, suggestion.projectId))) continue;
      showSuggestion(project.id, suggestion, link);
    }
  }
}

/** Hosts the host store reports as connected right now. */
function connectedHostIds(): Set<string> {
  return new Set(
    useHostStore
      .getState()
      .hosts.filter((h) => h.status === "connected")
      .map((h) => h.hostId),
  );
}

/**
 * Start this session's link suggestions, once the projects first load:
 * offer links between ungrouped projects that already share an `origin`, so
 * duplicates added before linking existed are found too. A remote host that
 * isn't connected yet can't report its checkouts' `origin`, so when a host
 * first connects in the session, its ungrouped projects are asked again.
 * A pair is offered once per session, from whichever side comes first.
 * `getProjects` reads the current project list when a host connects.
 */
export function startLinkSuggestions(
  getProjects: () => readonly LoadedProject[],
  link: LinkProjects,
): Promise<void> {
  stopWatchingHosts?.();
  offered.clear();
  // Hosts connected by now are covered by the pass below; a host is
  // re-asked only the first time it connects, not after every reconnect.
  const seen = connectedHostIds();
  stopWatchingHosts = useHostStore.subscribe(({ hosts }) => {
    for (const host of hosts) {
      if (host.status !== "connected" || seen.has(host.hostId)) continue;
      seen.add(host.hostId);
      const onHost = getProjects().filter((p) => !p.group && p.hostId === host.hostId);
      void offerForEach(onHost, link);
    }
  });
  return offerForEach(
    getProjects().filter((p) => !p.group),
    link,
  );
}

/**
 * Close the open suggestion toasts that name any of `projectIds`, once they
 * are linked: those offers are stale, and the pair is not offered again this
 * session.
 */
export function clearLinkSuggestionsFor(projectIds: readonly string[]): void {
  const { removeToast } = useToastStore.getState();
  for (const [id, pair] of offered) {
    if (pair.some((projectId) => projectIds.includes(projectId))) removeToast(id);
  }
}
