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

/** One pair to offer: `projectId` and what main suggested linking it with. */
interface Offer {
  projectId: string;
  suggestion: LinkSuggestion;
  link: LinkProjects;
}

/**
 * A background pass (launch or host connect) that finds more new pairs than
 * this shows one summary toast instead of a toast per pair.
 */
const MAX_BACKGROUND_TOASTS = 2;
const SUMMARY_TOAST_ID = "link-suggestions-summary";
/** Offers waiting behind the summary toast, in the order found. */
let held: Offer[] = [];
/** The user hid the summary: later background bursts stay quiet this session. */
let summaryHidden = false;

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
  (await newOffers([{ id: projectId }], link)).forEach(show);
}

/**
 * The pairs among `projects`' suggestions not yet offered this session,
 * each marked as offered. One project at a time, so each host is asked for
 * each checkout's `origin` once. Dismissed pairs never come back from main.
 */
async function newOffers(
  projects: readonly { id: string }[],
  link: LinkProjects,
): Promise<Offer[]> {
  const found: Offer[] = [];
  for (const project of projects) {
    for (const suggestion of await suggestionsFor(project.id)) {
      const id = linkSuggestionToastId(project.id, suggestion.projectId);
      if (offered.has(id)) continue;
      offered.set(id, [project.id, suggestion.projectId]);
      found.push({ projectId: project.id, suggestion, link });
    }
  }
  return found;
}

function show(offer: Offer): void {
  showSuggestion(offer.projectId, offer.suggestion, offer.link);
}

/**
 * The summary toast for `held`, or none when nothing is held. "Review" shows
 * the next held pair as its own toast; "Dismiss" only hides the summary for
 * the session, remembering nothing.
 */
function showSummary(): void {
  const { addToast, removeToast } = useToastStore.getState();
  if (held.length === 0) {
    removeToast(SUMMARY_TOAST_ID);
    return;
  }
  addToast({
    id: SUMMARY_TOAST_ID,
    status: "info",
    persistent: true,
    message: `${held.length} projects on other hosts could be linked`,
    detail: "Each is a clone of the same repo as a project on another host.",
    action: {
      label: "Review",
      onClick: () => {
        const next = held.shift();
        if (next) show(next);
        showSummary();
      },
    },
    secondaryAction: {
      label: "Dismiss",
      onClick: () => {
        held = [];
        summaryHidden = true;
        removeToast(SUMMARY_TOAST_ID);
      },
    },
  });
}

/**
 * A launch or host-connect pass: a few new pairs get a toast each; a burst
 * of more, or any while a summary is already up, joins the summary instead,
 * so a sidebar full of duplicates doesn't stack a toast per repo.
 */
async function offerInBackground(
  projects: readonly { id: string }[],
  link: LinkProjects,
): Promise<void> {
  const found = await newOffers(projects, link);
  if (held.length === 0 && found.length <= MAX_BACKGROUND_TOASTS) {
    found.forEach(show);
    return;
  }
  if (summaryHidden) return;
  held.push(...found);
  showSummary();
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
 * A pair is offered once per session, from whichever side comes first,
 * and a pass that finds many shows one summary (`offerInBackground`).
 * `getProjects` reads the current project list when a host connects.
 */
export function startLinkSuggestions(
  getProjects: () => readonly LoadedProject[],
  link: LinkProjects,
): Promise<void> {
  stopWatchingHosts?.();
  offered.clear();
  held = [];
  summaryHidden = false;
  useToastStore.getState().removeToast(SUMMARY_TOAST_ID);
  // Hosts connected by now are covered by the pass below; a host is
  // re-asked only the first time it connects, not after every reconnect.
  const seen = connectedHostIds();
  stopWatchingHosts = useHostStore.subscribe(({ hosts }) => {
    for (const host of hosts) {
      if (host.status !== "connected" || seen.has(host.hostId)) continue;
      seen.add(host.hostId);
      const onHost = getProjects().filter((p) => !p.group && p.hostId === host.hostId);
      void offerInBackground(onHost, link);
    }
  });
  return offerInBackground(
    getProjects().filter((p) => !p.group),
    link,
  );
}

/**
 * Close the open suggestion toasts that name any of `projectIds`, once they
 * are linked, and drop such pairs from the summary: those offers are stale,
 * and the pair is not offered again this session.
 */
export function clearLinkSuggestionsFor(projectIds: readonly string[]): void {
  const { removeToast } = useToastStore.getState();
  const names = (a: string, b: string) => projectIds.includes(a) || projectIds.includes(b);
  for (const [id, [a, b]] of offered) {
    if (names(a, b)) removeToast(id);
  }
  if (held.length === 0) return;
  held = held.filter((o) => !names(o.projectId, o.suggestion.projectId));
  showSummary();
}
