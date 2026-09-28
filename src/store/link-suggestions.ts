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

/** What `offerLinkSuggestionsAtLaunch` needs of each loaded project. */
interface LoadedProject {
  id: string;
  group?: { id: string } | null;
}

/**
 * The toast id of one suggested pair, the same from either side, so a pair
 * is offered in at most one toast and asking again replaces it.
 */
export function linkSuggestionToastId(projectId: string, otherId: string): string {
  const [a, b] = projectId < otherId ? [projectId, otherId] : [otherId, projectId];
  return `link-suggestion-${a}-${b}`;
}

function isShown(id: string): boolean {
  return useToastStore.getState().toasts.some((t) => t.id === id);
}

/** One toast asking to link `projectId` with `suggestion`. */
function showSuggestion(
  projectId: string,
  suggestion: LinkSuggestion,
  link: LinkProjects,
): void {
  const { addToast, removeToast } = useToastStore.getState();
  const id = linkSuggestionToastId(projectId, suggestion.projectId);
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
 * without the user's click, and a failed lookup shows nothing.
 */
export async function offerLinkSuggestions(
  projectId: string,
  link: LinkProjects,
): Promise<void> {
  for (const suggestion of await suggestionsFor(projectId)) {
    showSuggestion(projectId, suggestion, link);
  }
}

/**
 * Once per launch, after the projects load: offer links between ungrouped
 * projects that already share an `origin`, so duplicates added before
 * linking existed are found too. Asked one project at a time, so each host
 * is asked for each checkout's `origin` once. A pair is offered once, from
 * whichever side comes first; dismissed pairs never come back from main.
 */
export async function offerLinkSuggestionsAtLaunch(
  projects: readonly LoadedProject[],
  link: LinkProjects,
): Promise<void> {
  for (const project of projects) {
    if (project.group) continue;
    for (const suggestion of await suggestionsFor(project.id)) {
      if (isShown(linkSuggestionToastId(project.id, suggestion.projectId))) continue;
      showSuggestion(project.id, suggestion, link);
    }
  }
}
