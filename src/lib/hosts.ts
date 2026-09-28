import { LOCAL_HOST_ID } from "./host-id";

export { LOCAL_HOST_ID };

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

/** What a project needs to say which host a workspace path is on. */
interface HostedProject {
  id?: string;
  path: string;
  hostId: string;
  workspaces: readonly { path: string }[];
}

/**
 * The host `workspacePath` lives on — the `hostId` of the project that has
 * it as its root or one of its workspaces — or null when no project has it.
 *
 * A local and a remote project can have the very same path (same username,
 * same default roots). Then `preferredProjectId`'s project wins when it has
 * the path — the caller's own project, typically the selected one — and
 * otherwise the first project that has it.
 */
export function hostIdForWorkspace(
  projects: readonly HostedProject[],
  workspacePath: string | null | undefined,
  preferredProjectId?: string | null,
): string | null {
  if (!workspacePath) return null;
  const has = (project: HostedProject) =>
    project.path === workspacePath ||
    project.workspaces.some((w) => w.path === workspacePath);
  const preferred = preferredProjectId
    ? projects.find((p) => p.id === preferredProjectId && has(p))
    : undefined;
  return (preferred ?? projects.find(has))?.hostId ?? null;
}

/**
 * The remote host `workspacePath` lives on (see `hostIdForWorkspace`), or
 * null when it is on this machine (or unknown).
 */
export function remoteHostIdForWorkspace(
  projects: readonly HostedProject[],
  workspacePath: string | undefined,
  preferredProjectId?: string | null,
): string | null {
  const hostId = hostIdForWorkspace(projects, workspacePath, preferredProjectId);
  return isRemoteHost(hostId) ? hostId : null;
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
