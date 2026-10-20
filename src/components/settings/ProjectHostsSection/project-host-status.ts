import type { HostDisplay, HostTone } from "../../../lib/host-status";
import { pendingDisplay } from "../../../lib/host-status";
import { isRemoteHost } from "../../../lib/hosts";

export type ProjectHostStatus = { word: string; tone: HostTone | null };

/**
 * The one word a project's host row shows beside its name:
 * "Local" for this machine, in no tone; a remote host's `status` in its
 * tone, falling back to the pending display before the host has reported.
 */
export function projectHostStatus(
  hostId: string,
  display: HostDisplay | undefined,
): ProjectHostStatus {
  if (!isRemoteHost(hostId)) return { word: "Local", tone: null };
  const shown = display ?? pendingDisplay(hostId);
  return { word: shown.status, tone: shown.tone };
}
