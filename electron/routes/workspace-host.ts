/**
 * The host of the workspace an app-command names (ADR-191). The renderer
 * keys layouts by host plus path, and a path alone can be on two hosts, so
 * main — which knows the projects and the caller — names the host.
 */

import { proxyToRenderer } from "../renderer-bridge";
import { callerMaySee, OWN_HOST_ONLY } from "./caller-host";
import type { ControlDeps, Json } from "./types";

/**
 * `body` with a `hostId` for its `workspacePath`, or a 403 to answer with.
 *
 * A request relayed from a remote `manor` CLI (ADR-189) acts on its own
 * host only: its `hostId` is the relaying host, and a body naming any other
 * host gets the same generic 403 every relayed route gives
 * (`callerMaySee`). A local caller's own `hostId` is kept; without one it is
 * the host of the project that owns the path. A body with no
 * `workspacePath` is returned as is.
 */
export function withWorkspaceHost(
  deps: Pick<ControlDeps, "projectManager" | "callerHostId">,
  body: Record<string, unknown>,
): { ok: true; body: Record<string, unknown> } | { ok: false; status: 403; error: string } {
  const workspacePath = body.workspacePath;
  if (typeof workspacePath !== "string") return { ok: true, body };
  const named = typeof body.hostId === "string" && body.hostId ? body.hostId : undefined;
  const { callerHostId } = deps;
  if (callerHostId) {
    if (named !== undefined && !callerMaySee(callerHostId, named)) {
      return { ok: false, status: 403, error: OWN_HOST_ONLY };
    }
    return { ok: true, body: { ...body, hostId: callerHostId } };
  }
  if (named !== undefined) return { ok: true, body };
  const hostId = deps.projectManager?.hostIdForPath(workspacePath);
  return { ok: true, body: hostId ? { ...body, hostId } : body };
}

/**
 * Proxy `cmd` to the renderer with `body`'s workspace host resolved by
 * `withWorkspaceHost`, or answer its 403.
 */
export async function proxyWithWorkspaceHost(
  deps: Pick<ControlDeps, "projectManager" | "callerHostId">,
  json: Json,
  cmd: string,
  body: Record<string, unknown>,
): Promise<void> {
  const resolved = withWorkspaceHost(deps, body);
  if (!resolved.ok) {
    json(resolved.status, { error: resolved.error });
    return;
  }
  await proxyToRenderer(json, cmd, resolved.body);
}
