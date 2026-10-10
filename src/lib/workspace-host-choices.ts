/**
 * The New Workspace dialog's host picker for a linked-project group
 * (ADR-192): one choice per member, each naming the member project a new
 * workspace would be created in. DOM-free, so the project-store tests drive
 * it directly. The rest of the dialog's decisions are in `new-workspace.ts`.
 */

import type { HostStatusInfo } from "../store/host-store";
import { describeHost } from "./host-status";
import { isRemoteHost } from "./hosts";

/** What the picker needs of a project. */
interface GroupedProject {
  id: string;
  hostId: string;
  group?: { memberIds: readonly string[]; lastUsedHostId: string | null } | null;
}

export interface WorkspaceHostChoice {
  /** The member project a workspace on this host is created in. */
  projectId: string;
  hostId: string;
  /** Why no workspace can be created on this host now; null when it can. */
  disabledReason: string | null;
}

/**
 * The host choices for creating a workspace in `project`'s group, in section
 * order, or null when `project` isn't linked (no picker). A remote host main
 * reports as anything but connected is disabled; one it hasn't reported yet
 * is not, the same rule as pane input (`isHostOffline`).
 */
export function workspaceHostChoices(
  project: GroupedProject | undefined,
  projects: readonly GroupedProject[],
  hosts: readonly HostStatusInfo[],
): WorkspaceHostChoice[] | null {
  if (!project?.group) return null;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const choices: WorkspaceHostChoice[] = [];
  for (const id of project.group.memberIds) {
    const member = byId.get(id);
    if (!member) continue;
    const host = hosts.find((h) => h.hostId === member.hostId);
    const display = isRemoteHost(member.hostId) ? describeHost(host, Date.now()) : undefined;
    choices.push({
      projectId: member.id,
      hostId: member.hostId,
      disabledReason: display?.offline
        ? `${display.target} isn't connected (${display.status.toLowerCase()}). Reconnect it to create a workspace there.`
        : null,
    });
  }
  return choices.length > 1 ? choices : null;
}

/**
 * The member project the picker starts on. In order, the first of these
 * whose host is available: `preferredProjectId` (the dialog was opened from
 * that member's own section or folder), the group's last-used host, the
 * project the dialog was opened for, then any member. When every host is
 * offline it falls back to the last-used member, so the picker still shows
 * a selection and create explains why it can't go ahead.
 */
function defaultHostChoice(
  choices: readonly WorkspaceHostChoice[],
  lastUsedHostId: string | null,
  openedForProjectId: string,
  preferredProjectId?: string | null,
): string {
  const available = choices.filter((c) => c.disabledReason === null);
  const lastUsed = choices.find((c) => c.hostId === lastUsedHostId);
  const candidates = [
    available.find((c) => c.projectId === preferredProjectId),
    available.find((c) => c === lastUsed),
    available.find((c) => c.projectId === openedForProjectId),
    available[0],
    lastUsed,
  ];
  return candidates.find((c) => c !== undefined)?.projectId ?? openedForProjectId;
}

/**
 * The member the dialog starts on when opened for `openedForId`, or
 * `openedForId` itself when it isn't linked. See `defaultHostChoice`.
 */
export function startingMemberId(
  openedForId: string,
  projects: readonly GroupedProject[],
  hosts: readonly HostStatusInfo[],
  preferredMemberId?: string | null,
): string {
  const project = projects.find((p) => p.id === openedForId);
  const choices = workspaceHostChoices(project, projects, hosts);
  if (!choices || !project?.group) return openedForId;
  return defaultHostChoice(choices, project.group.lastUsedHostId, openedForId, preferredMemberId);
}

/** A host the set-up dialog offers. */
export interface CloneHostChoice {
  hostId: string;
  /** Why setting up on this host can't run now; null when it can. */
  disabledReason: string | null;
}

/**
 * The member the New Workspace dialog moves to once "Set up on another
 * host…" succeeds: the new project, when it joined `groupId`. Null when linking
 * failed, so the dialog stays where it was.
 */
export function memberAfterClone(
  cloned: { id: string; group?: { id: string } | null },
  groupId: string | undefined,
): string | null {
  return groupId && cloned.group?.id === groupId ? cloned.id : null;
}
