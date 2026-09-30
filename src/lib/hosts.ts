import { LOCAL_HOST_ID, type HostId } from "./workspace-key";

export { LOCAL_HOST_ID };
export type { HostId };

/**
 * Kept only until `home-dashboard.ts` moves over to `ownerOf` from
 * `workspace-directory.ts` (ADR-204 §4); then this re-export goes. New code
 * imports `ownerOf` directly.
 */
export { ownerOf as projectForWorkspaceKey } from "./workspace-directory";

/** Mirrors `HealthCheckResult` in `electron/backend/health-check.ts`. */
export interface HealthCheckResult {
  id: "origin" | "claude" | "codex" | "gh";
  label: string;
  /** Derived from `status`: `true` only for `"ok"`. */
  ok: boolean;
  /**
   * `"unknown"` is a neutral, unverified state (e.g. Claude login, which has
   * no reliable non-interactive probe) — render it distinctly from `"fail"`,
   * not as a red failure.
   */
  status: "ok" | "fail" | "unknown";
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}

/** Whether `hostId` refers to a remote host — anything but `LOCAL_HOST_ID`. */
export function isRemoteHost(hostId: string | null | undefined): boolean {
  return !!hostId && hostId !== LOCAL_HOST_ID;
}

/**
 * How a host is named in a sentence: its ssh target, or "this machine".
 * A remote host main hasn't reported yet is named by its id.
 */
export function hostLabel(
  hostId: string,
  hosts: readonly { hostId: string; spec?: { target?: string } | null }[],
): string {
  if (!isRemoteHost(hostId)) return "this machine";
  return hosts.find((h) => h.hostId === hostId)?.spec?.target ?? hostId;
}

/**
 * A linked member's host as a label, as the sidebar's group sections name
 * it (ADR-193): "This machine", or the remote host's ssh target.
 */
export function memberHostName(
  hostId: string,
  hosts: readonly { hostId: string; spec?: { target?: string } | null }[],
): string {
  return isRemoteHost(hostId) ? hostLabel(hostId, hosts) : "This machine";
}

/**
 * `{ value, label }` options for every remote host, for the searchable
 * selects in `AddProjectDialog` and `ProjectHostSection` (ADR-183 ticket 10).
 */
export function remoteHostOptions(
  hosts: readonly { hostId: string; spec?: { target?: string } | null }[],
): { value: string; label: string }[] {
  return hosts
    .filter((h) => isRemoteHost(h.hostId))
    .map((h) => ({ value: h.hostId, label: h.spec?.target ?? h.hostId }));
}

/**
 * An http(s) URL on this machine's loopback, or a portless `*.localhost`
 * one — either may really mean a dev server on a remote host.
 */
export function isLocalhostHttpUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|\?|#|$)/i.test(
    url,
  );
}

/**
 * `url` — the box's own `localhost:<port>` URL — through its port forward
 * on `hostId`, or `url` itself if main can't resolve one (ADR-178 §5).
 * Shared by `PortBadge`'s `withResolvedUrl` and `useRemoteBrowserUrl`
 * (ADR-183 ticket 10).
 */
export async function resolveUrlForHost(url: string, hostId: string): Promise<string> {
  try {
    return await window.electronAPI.ports.resolveUrl(url, hostId);
  } catch {
    return url;
  }
}
