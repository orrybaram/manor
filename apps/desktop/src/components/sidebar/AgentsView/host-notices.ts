import type { HostStatus, HostStatusInfo } from "../../../store/host-store";
import { hostName, isRemoteHost } from "../../../lib/hosts";

/** One line above the list: a host whose Sessions the list can't show. */
export interface HostNotice {
  hostId: string;
  message: string;
}

const REASONS: Partial<Record<HostStatus, string>> = {
  disconnected: "it isn't connected",
  connecting: "it's still connecting",
  reconnecting: "it's reconnecting",
  error: "it can't be reached",
  sleeping: "it's asleep",
};

/**
 * A notice for each remote host that isn't connected, since its Sessions
 * can't be read; the rest of the list is every other host's.
 */
export function hostNotices(
  hosts: readonly Pick<HostStatusInfo, "hostId" | "status" | "label" | "spec">[],
): HostNotice[] {
  const notices: HostNotice[] = [];
  for (const host of hosts) {
    if (!isRemoteHost(host.hostId)) continue;
    const reason = REASONS[host.status];
    if (reason) {
      notices.push({ hostId: host.hostId, message: `Sessions on ${hostName(host)} aren't shown — ${reason}` });
    }
  }
  return notices;
}
