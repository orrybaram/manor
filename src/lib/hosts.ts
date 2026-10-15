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
  id: "origin" | "agent" | "gh";
  label: string;
  /** Derived from `status`: `true` only for `"ok"`. */
  ok: boolean;
  /**
   * `"unknown"` is a neutral, unverified state (e.g. a login with no reliable
   * non-interactive probe) — render it distinctly from `"fail"`,
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
 * What a host is named by: main's `label` for it, else its ssh target, else
 * its id. A host list entry, or the slice of one that names it.
 */
export interface NamedHost {
  hostId: string;
  /** The ssh target, or a recipe host's recipe name (ADR-229 D2). */
  label?: string;
  spec?: { kind: "ssh"; target: string } | { kind: "recipe"; recipeId: string } | null;
}

/**
 * A remote host's name: its ssh target, or for a host Manor starts, its
 * recipe's name (ADR-229 D2). Falls back to the id.
 */
export function hostName(host: NamedHost): string {
  if (host.label) return host.label;
  return host.spec?.kind === "ssh" ? host.spec.target : host.hostId;
}

/**
 * How a host is named in a sentence: its name (`hostName`), or "this
 * machine". A remote host main hasn't reported yet is named by its id.
 */
export function hostLabel(hostId: string, hosts: readonly NamedHost[]): string {
  if (!isRemoteHost(hostId)) return "this machine";
  const host = hosts.find((h) => h.hostId === hostId);
  return host ? hostName(host) : hostId;
}

/**
 * A linked member's host as a label, as the sidebar's group sections name
 * it (ADR-193): "This machine", or the remote host's ssh target.
 */
export function memberHostName(hostId: string, hosts: readonly NamedHost[]): string {
  return isRemoteHost(hostId) ? hostLabel(hostId, hosts) : "This machine";
}

/**
 * `{ value, label }` options for every remote host, for the searchable
 * selects in `AddProjectDialog` and `ProjectHostSection` (ADR-183 ticket 10).
 */
export function remoteHostOptions(
  hosts: readonly NamedHost[],
): { value: string; label: string }[] {
  return hosts
    .filter((h) => isRemoteHost(h.hostId))
    .map((h) => ({ value: h.hostId, label: hostName(h) }));
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

