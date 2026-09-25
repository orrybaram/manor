/**
 * Mirrors `LOCAL_HOST_ID` in `electron/backend/types.ts` — the host every
 * project without a `hostId` lives on: this machine.
 */
export const LOCAL_HOST_ID = "local";

/** Mirrors `HealthCheckResult` in `electron/backend/health-check.ts`. */
export interface HealthCheckResult {
  id: "origin" | "claude" | "codex" | "gh";
  label: string;
  ok: boolean;
  /**
   * `"unknown"` is a neutral, unverified state (e.g. Claude login, which has
   * no reliable non-interactive probe) — render it distinctly from `"fail"`,
   * not as a red failure.
   */
  status?: "ok" | "fail" | "unknown";
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}

/**
 * The remote host `workspacePath` lives on — the `hostId` of the project
 * that has it as its root or one of its workspaces — or null when it is on
 * this machine (or unknown).
 */
export function remoteHostIdForWorkspace(
  projects: readonly {
    path: string;
    hostId?: string;
    workspaces: readonly { path: string }[];
  }[],
  workspacePath: string | undefined,
): string | null {
  if (!workspacePath) return null;
  for (const project of projects) {
    if (
      project.path === workspacePath ||
      project.workspaces.some((w) => w.path === workspacePath)
    ) {
      return project.hostId && project.hostId !== LOCAL_HOST_ID ? project.hostId : null;
    }
  }
  return null;
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
