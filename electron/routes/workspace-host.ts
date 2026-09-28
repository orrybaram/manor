/**
 * The host of the workspace an app-command names (ADR-191). The renderer
 * keys layouts by host plus path, and a path alone can be on two hosts, so
 * main — which knows the projects and the caller — names the host.
 */

import type { ControlDeps } from "./types";

/**
 * `body` with a `hostId` for its `workspacePath`: the caller's own when it
 * gave one, the relaying host's for a request from a remote `manor` CLI
 * (ADR-189), else the host of the project that owns the path. A body with no
 * `workspacePath` is returned as is.
 */
export function withWorkspaceHost(
  deps: Pick<ControlDeps, "projectManager" | "callerHostId">,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const workspacePath = body.workspacePath;
  if (typeof workspacePath !== "string") return body;
  if (typeof body.hostId === "string" && body.hostId) return body;
  const hostId =
    deps.callerHostId ?? deps.projectManager?.hostIdForPath(workspacePath) ?? undefined;
  return hostId ? { ...body, hostId } : body;
}
