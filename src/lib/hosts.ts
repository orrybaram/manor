import { isHomePath } from "./home-path";
import { LOCAL_HOST_ID, normalizeHostId, type HostId } from "./host-id";
import { parseWorkspaceKey } from "./workspace-key";

export { LOCAL_HOST_ID };
export type { HostId };

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
export interface HostedProject {
  id?: string;
  path: string;
  hostId: HostId;
  workspaces: readonly { path: string }[];
}

/** The project list and which project is selected, as the project store has them. */
export interface ProjectSelection<P extends HostedProject = HostedProject> {
  projects: readonly P[];
  selectedProjectIndex: number;
}

/** Whether `project` has `workspacePath`: its main checkout or one of its workspaces. */
function hasWorkspace(project: HostedProject, workspacePath: string): boolean {
  return (
    project.path === workspacePath ||
    project.workspaces.some((w) => w.path === workspacePath)
  );
}

/**
 * The project that has `workspacePath` as its main checkout or one of its
 * workspaces, or undefined when none does.
 *
 * A local and a remote project can have the very same path (same username,
 * same default roots). Then `preferredProjectId`'s project wins when it has
 * the path — the caller's own project, typically the selected one — and
 * otherwise the first project that has it.
 */
export function projectForWorkspace<P extends HostedProject>(
  projects: readonly P[],
  workspacePath: string | null | undefined,
  preferredProjectId?: string,
): P | undefined {
  if (!workspacePath) return undefined;
  const preferred = preferredProjectId
    ? projects.find((p) => p.id === preferredProjectId && hasWorkspace(p, workspacePath))
    : undefined;
  return preferred ?? projects.find((p) => hasWorkspace(p, workspacePath));
}

/**
 * The host `workspacePath` lives on — the `hostId` of its project (see
 * `projectForWorkspace`) — or undefined when no project has it.
 */
export function hostIdForWorkspace(
  projects: readonly HostedProject[],
  workspacePath: string | null | undefined,
  preferredProjectId?: string,
): HostId | undefined {
  return projectForWorkspace(projects, workspacePath, preferredProjectId)?.hostId;
}

/**
 * The project that has the workspace keyed `key` (ADR-191): on the key's
 * host, with the key's path as its main checkout or one of its workspaces.
 * Undefined for Home and for a path no project on that host has.
 */
export function projectForWorkspaceKey<P extends HostedProject>(
  projects: readonly P[],
  key: string | null | undefined,
): P | undefined {
  if (!key) return undefined;
  const { hostId, path } = parseWorkspaceKey(key);
  return projects.find(
    (p) => normalizeHostId(p.hostId) === hostId && hasWorkspace(p, path),
  );
}

/** The id of the selected project, if any. */
export function selectedProjectId(selection: ProjectSelection): string | undefined {
  return selection.projects[selection.selectedProjectIndex]?.id;
}

/**
 * The host of workspace `workspacePath` for a caller that knows only its
 * path: the host of the project that has it, the selected project first when
 * two share the path — it is the one whose workspace the user opened. Home
 * is on this machine. Undefined when no project has the path, so main falls
 * back to the host the path belongs to.
 *
 * A pane never needs this: it takes its host from the key of the workspace
 * it belongs to (`paneCreateHostId`, ADR-191).
 */
export function workspaceHostId(
  selection: ProjectSelection,
  workspacePath: string | null | undefined,
): HostId | undefined {
  if (isHomePath(workspacePath)) return LOCAL_HOST_ID;
  return workspaceProject(selection, workspacePath)?.hostId;
}

/**
 * The project whose workspace `workspacePath` is, as the user opened it: the
 * selected project first when two share the path — in a linked group
 * (ADR-192) the member whose section the workspace was picked from. What the
 * status bar's host chip and the tab badge speak for.
 */
export function workspaceProject<P extends HostedProject>(
  selection: ProjectSelection<P>,
  workspacePath: string | null | undefined,
): P | undefined {
  return projectForWorkspace(selection.projects, workspacePath, selectedProjectId(selection));
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
