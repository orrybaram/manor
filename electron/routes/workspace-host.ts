/**
 * The host of the workspace an app-command names (ADR-191). The renderer
 * keys layouts by host plus path, and a path alone can be on two hosts, so
 * main — which knows the projects and the caller — names the host.
 */

import type { ServerRouteDeps } from "./types";

/**
 * `body` with a `hostId` for its `workspacePath`, or a 403 to answer with.
 *
 * A body's own `hostId` is kept; without one it is the host of the
 * project that owns the path. A body with no
 * `workspacePath` is returned as is.
 */
export function withWorkspaceHost(
  deps: Pick<ServerRouteDeps, "projectManager">,
  body: Record<string, unknown>,
): { ok: true; body: Record<string, unknown> } | { ok: false; status: 403; error: string } {
  const workspacePath = body.workspacePath;
  if (typeof workspacePath !== "string") return { ok: true, body };
  const named = typeof body.hostId === "string" && body.hostId ? body.hostId : undefined;
  if (named !== undefined) return { ok: true, body };
  const hostId = deps.projectManager?.hostIdForPath(workspacePath);
  return { ok: true, body: hostId ? { ...body, hostId } : body };
}
