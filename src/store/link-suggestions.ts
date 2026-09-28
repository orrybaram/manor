import { useToastStore } from "./toast-store";

/** Mirrors `LinkSuggestion` in `electron/projects/types.ts` (ADR-192 ticket 5). */
export interface LinkSuggestion {
  /** The project to link with: a lone project, or a group's first member. */
  projectId: string;
  /** The project's name, or its group's. */
  name: string;
  hostId: string;
  /** Where it lives: its host's label, or a group's hosts' labels. */
  hostLabel: string;
  /** The group it would join, or null for a lone project. */
  groupId: string | null;
}

type LinkProjects = (projectId: string, otherId: string) => Promise<void>;

/** The toast id of one suggestion, so asking twice replaces rather than stacks. */
export function linkSuggestionToastId(projectId: string, otherId: string): string {
  return `link-suggestion-${projectId}-${otherId}`;
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
  let suggestions: LinkSuggestion[];
  try {
    suggestions = await window.electronAPI.projects.suggestLinks(projectId);
  } catch {
    return;
  }
  const { addToast, removeToast } = useToastStore.getState();
  for (const suggestion of suggestions) {
    const id = linkSuggestionToastId(projectId, suggestion.projectId);
    addToast({
      id,
      status: "success",
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
}
