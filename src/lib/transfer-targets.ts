/**
 * The hosts a project can be copied or moved to (ADR-213). DOM-free, built
 * from the same parts as `hostsToCloneOnto`, but for any project: an
 * unlinked one gets targets too.
 */

import type { HostStatusInfo } from "../store/host-store";
import { describeHost } from "./host-status";
import { LOCAL_HOST_ID, isRemoteHost, memberHostName } from "./hosts";
import type { TransferMode } from "../electron";

/** What the targets need of a project. */
interface TransferProject {
  id: string;
  hostId: string;
  group?: { memberIds: readonly string[] } | null;
}

export interface TransferTarget {
  hostId: string;
  /** "This machine", or the remote host's ssh target. */
  label: string;
  /** Why a transfer onto this host can't run now; null when it can. */
  disabledReason: string | null;
}

/**
 * "This machine" first, then every registered remote host, minus `project`'s
 * own host. A host is disabled when its last connect failed (`error`; one
 * merely disconnected is not, since the transfer connects it), or when the
 * project's group already has a member there: any member for a copy, any
 * other member for a move (the project itself is on the excluded host).
 */
export function transferTargets(
  project: TransferProject,
  projects: readonly TransferProject[],
  hosts: readonly HostStatusInfo[],
  mode: TransferMode,
): TransferTarget[] {
  const memberIds = new Set(project.group?.memberIds ?? []);
  const taken = new Set(
    projects
      .filter((p) => p.id !== project.id && memberIds.has(p.id))
      .map((p) => p.hostId),
  );
  const ids = [LOCAL_HOST_ID, ...hosts.filter((h) => isRemoteHost(h.hostId)).map((h) => h.hostId)];
  return ids
    .filter((hostId) => hostId !== project.hostId)
    .map((hostId) => {
      const label = memberHostName(hostId, hosts);
      const host = hosts.find((h) => h.hostId === hostId);
      const display = host?.status === "error" ? describeHost(host, Date.now()) : undefined;
      let disabledReason: string | null = null;
      if (taken.has(hostId)) {
        disabledReason = `Already on ${label}`;
      } else if (display) {
        disabledReason = `${display.target} is offline (${display.status.toLowerCase()}). Reconnect it to ${mode === "copy" ? "copy" : "move"} there.`;
      }
      return { hostId, label, disabledReason };
    });
}
