/**
 * The desktop's control routes for an adopted host.
 *
 * Once a remote host has adopted its records, its projects, workspaces and
 * agents are its server's. A control-route write that names one — a
 * workspace created by MCP, an agent launched by the CLI, a folder renamed —
 * is not the desktop's to carry out: it goes to that host's server whole, as
 * the request it is (`hostServer.control`), and runs there through the same
 * route (`./server-routes.ts`). The bridge's methods reach the host the same
 * way, through the same `HostRouting` (`BridgeServer`'s `forward`).
 *
 * The answer comes back in the desktop's form: `hostId` stamped on the
 * host's records, and a project decorated as the desktop's merged list
 * shows it (its group, its host's label). A host that is away answers 503,
 * naming it.
 *
 * On a host server there is no `hostRouting`: every project is its own, and
 * nothing here forwards.
 */

import type { ProjectInfo } from "../persistence";
import type { Json, ServerRouteDeps } from "./types";

type ForwardDeps = Pick<ServerRouteDeps, "hostRouting" | "projectManager">;

/** Whether `hostId` has adopted its records: requests for it are its server's. */
export function onAdoptedHost(
  deps: Pick<ServerRouteDeps, "hostRouting">,
  hostId: string | null | undefined,
): hostId is string {
  return !!hostId && !!deps.hostRouting?.proxy(hostId);
}

function isProject(value: unknown): value is ProjectInfo & { host?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProjectInfo).id === "string" &&
    Array.isArray((value as ProjectInfo).workspaces)
  );
}

/** A host's answer body, with each project in it as the desktop lists it. */
function toDesktopBody(deps: ForwardDeps, hostId: string, body: unknown): unknown {
  if (!isProject(body)) return body;
  const decorated = deps.projectManager.decorateRemoteResult(body) as ProjectInfo;
  // The host labels itself "local"; the desktop's listings name it.
  return "host" in body
    ? { ...decorated, host: deps.projectManager.hostLabel(hostId) }
    : decorated;
}

/**
 * `method path` with `body`, answered by `hostId`'s server, in the desktop's
 * form. Never rejects: a host that is away, or refuses, is a 503.
 */
export async function askHost(
  deps: ForwardDeps,
  hostId: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const routing = deps.hostRouting;
  if (!routing) return { status: 503, body: { error: `${hostId} is offline` } };
  const answer = await routing.control(hostId, method, path, body);
  return { status: answer.status, body: toDesktopBody(deps, hostId, answer.body) };
}

/** `askHost`, written as this request's response. */
export async function forwardToHost(
  deps: ForwardDeps,
  json: Json,
  hostId: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const answer = await askHost(deps, hostId, method, path, body);
  json(answer.status, answer.body);
}
