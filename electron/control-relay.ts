/**
 * Control requests relayed from a remote host's `manor` CLI (ADR-189 §2).
 *
 * The CLI on a remote box talks to its daemon, which relays each request down
 * the stream to this app (`RemoteHostConnection`). Here it runs through the
 * same route table the local control server dispatches, with the same deps —
 * but only if it is on `REMOTE_CONTROL_ALLOWLIST`. A remote agent gets what it
 * needs to find its project and fan out workspaces and agents; it does not get
 * to delete projects, run git, drive panes or poke other agents' sessions.
 *
 * And only on its own host: a request naming another host's project or
 * workspace is refused, and the project and agent lists it reads are cut down
 * to the calling host's. A box must not be able to add or delete worktrees on
 * the laptop, or launch agents there.
 */

import { errorMessage } from "./lib/errors";
import { handleControlRequest } from "./routes";
import type { ControlDeps } from "./routes/types";
import type { ProjectInfo } from "./persistence";
import type {
  ControlRelayResult,
  RelayedControlRequest,
} from "./terminal-host/control-relay-listener";

export interface RemoteControlRoute {
  method: "GET" | "POST" | "DELETE";
  /** Matched against the pathname with empty segments dropped (see `normalize`). */
  pattern: RegExp;
}

/** One path segment, as the router's `:param` would capture it. */
const ID = "[^/]+";

const route = (method: RemoteControlRoute["method"], path: string): RemoteControlRoute => ({
  method,
  pattern: new RegExp(`^${path}$`),
});

/**
 * Every route a remote host's CLI may call. Data, so widening it is a
 * one-line change. Each entry names one route in `electron/routes/` (the
 * `:projectId` etc. segments become `ID`); a pathname that matches an entry
 * can only dispatch to that route, since the router matches on method and
 * static segments the same way.
 */
export const REMOTE_CONTROL_ALLOWLIST: readonly RemoteControlRoute[] = [
  // Context
  route("GET", "/context"),
  // Projects (read)
  route("GET", "/projects"),
  route("GET", `/projects/${ID}`),
  route("GET", `/projects/${ID}/branches`),
  // Workspaces
  route("GET", `/projects/${ID}/workspaces`),
  route("POST", `/projects/${ID}/workspaces`),
  route("DELETE", `/projects/${ID}/workspaces`),
  route("POST", `/projects/${ID}/workspaces/(batch|rename|hidden|reorder)`),
  // Folders — all of routes/folders.ts
  route("GET", `/projects/${ID}/folders`),
  route("POST", `/projects/${ID}/folders`),
  route("POST", `/projects/${ID}/folders/${ID}/(rename|parent)`),
  route("DELETE", `/projects/${ID}/folders/${ID}`),
  route("POST", `/projects/${ID}/workspaces/folder`),
  // Issues
  route("GET", `/projects/${ID}/issues`),
  route("POST", `/projects/${ID}/issues`),
  route("GET", `/projects/${ID}/issues/${ID}`),
  route("GET", `/projects/${ID}/workspaces/issues`),
  route("POST", `/projects/${ID}/workspaces/issues`),
  route("DELETE", `/projects/${ID}/workspaces/issues`),
  // Agents
  route("GET", "/agents"),
  route("POST", "/agents"),
];

/**
 * `pathname` the way the router sees it: it splits on `/` and drops empty
 * segments, so `//projects/` dispatches as `/projects`. Matching the same
 * form keeps the allowlist and the router agreeing on what a path is.
 */
function normalize(pathname: string): string {
  return "/" + pathname.split("/").filter(Boolean).join("/");
}

/** Whether a remote host's CLI may call `method pathname`. */
export function isRemoteAllowed(method: string, pathname: string): boolean {
  const path = normalize(pathname);
  return REMOTE_CONTROL_ALLOWLIST.some(
    (r) => r.method === method && r.pattern.test(path),
  );
}

/** A project's id as it appears in a `/projects/:projectId/…` path. */
const PROJECT_PATH = /^\/projects\/([^/]+)/;

/** The calling host's projects. */
async function hostProjects(deps: ControlDeps, hostId: string): Promise<ProjectInfo[]> {
  const projects = (await deps.projectManager?.getProjects()) ?? [];
  return projects.filter((p) => p.hostId === hostId);
}

const notOnHost = (what: string): ControlRelayResult => ({
  status: 404,
  body: { error: `No ${what} on this host` },
});

/**
 * A 404 when the request names a project or workspace that isn't on the
 * calling host, null when it may go ahead. Another host's project answers the
 * same as a missing one, so a box learns nothing about the laptop's projects.
 */
async function refuseOtherHosts(
  deps: ControlDeps,
  hostId: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<ControlRelayResult | null> {
  const projectSegment = PROJECT_PATH.exec(path)?.[1];
  const workspacePath =
    method === "POST" && path === "/agents" && typeof body.workspacePath === "string"
      ? body.workspacePath
      : undefined;
  if (projectSegment === undefined && workspacePath === undefined) return null;

  const own = await hostProjects(deps, hostId);
  if (projectSegment !== undefined) {
    let projectId: string;
    try {
      projectId = decodeURIComponent(projectSegment);
    } catch {
      return notOnHost(`project '${projectSegment}'`);
    }
    if (!own.some((p) => p.id === projectId)) return notOnHost(`project '${projectId}'`);
  }
  if (
    workspacePath !== undefined &&
    !own.some((p) => p.workspaces.some((w) => w.path === workspacePath))
  ) {
    return notOnHost(`workspace at '${workspacePath}'`);
  }
  return null;
}

/**
 * Cut a list answer down to the calling host's entries: `GET /projects` to its
 * projects, `GET /agents` to agents in them. Anything else passes through.
 */
async function scopeToHost(
  deps: ControlDeps,
  hostId: string,
  method: string,
  path: string,
  result: ControlRelayResult,
): Promise<ControlRelayResult> {
  if (method !== "GET" || result.status !== 200 || !Array.isArray(result.body)) return result;
  if (path !== "/projects" && path !== "/agents") return result;
  const own = await hostProjects(deps, hostId);
  const ownIds = new Set(own.map((p) => p.id));
  const entries = result.body as Array<{ id?: unknown; projectId?: unknown }>;
  const kept =
    path === "/projects"
      ? entries.filter((p) => ownIds.has(p.id as string))
      : entries.filter((a) => ownIds.has(a.projectId as string));
  return { status: result.status, body: kept };
}

/**
 * Answer one relayed request: 403 off the allowlist, 404 when it names another
 * host's project or workspace, otherwise whatever the route answers — with
 * `callerHostId` set so host-aware routes (`/context`) scope to the calling
 * host, and list answers cut down to it. 404 when no route matched; 500 when
 * the route threw before answering. Never rejects.
 */
export async function handleRelayedControlRequest(
  deps: ControlDeps,
  hostId: string,
  req: RelayedControlRequest,
): Promise<ControlRelayResult> {
  const method = req.method.toUpperCase();
  const url = new URL(req.path, "http://relay");
  if (!isRemoteAllowed(method, url.pathname)) {
    return {
      status: 403,
      body: { error: `${method} ${url.pathname} isn't available from remote hosts` },
    };
  }

  // Routes expect an object body, as the HTTP listener's JSON parse gives.
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const path = normalize(url.pathname);

  try {
    const refusal = await refuseOtherHosts(deps, hostId, method, path, body);
    if (refusal) return refusal;
    const result = await dispatchRelayed(deps, hostId, method, url, body);
    return await scopeToHost(deps, hostId, method, path, result);
  } catch (err) {
    return { status: 500, body: { error: errorMessage(err) } };
  }
}

/**
 * Run the request through the route table and capture its answer. 404 when no
 * route matched; 500 when the route threw before answering (a route that threw
 * after answering keeps its answer).
 */
async function dispatchRelayed(
  deps: ControlDeps,
  hostId: string,
  method: string,
  url: URL,
  body: Record<string, unknown>,
): Promise<ControlRelayResult> {
  const captured: { result?: ControlRelayResult } = {};
  const json = (status: number, body: unknown): void => {
    // A route answers once; keep the first, as an HTTP response would.
    captured.result ??= { status, body };
  };

  let handled: boolean;
  try {
    handled = await handleControlRequest(
      { ...deps, callerHostId: hostId },
      method,
      url,
      json,
      async () => body,
    );
  } catch (err) {
    return captured.result ?? { status: 500, body: { error: errorMessage(err) } };
  }
  if (captured.result) return captured.result;
  if (!handled) {
    return { status: 404, body: { error: `No route for ${method} ${url.pathname}` } };
  }
  return { status: 500, body: { error: `${method} ${url.pathname} sent no response` } };
}
