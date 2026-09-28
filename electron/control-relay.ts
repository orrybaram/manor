/**
 * Control requests relayed from a remote host's `manor` CLI (ADR-189 §2).
 *
 * The CLI on a remote box talks to its daemon, which relays each request down
 * the stream to this app (`RemoteHostConnection`). Here it runs through the
 * same route table the local control server dispatches, with the same deps —
 * but only if it is on `REMOTE_CONTROL_ALLOWLIST`. A remote agent gets what it
 * needs to find its project and fan out workspaces and agents; it does not get
 * to delete projects, run git, drive panes or poke other agents' sessions.
 */

import { errorMessage } from "./lib/errors";
import { handleControlRequest } from "./routes";
import type { ControlDeps } from "./routes/types";
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

/**
 * Answer one relayed request: 403 off the allowlist, otherwise whatever the
 * route answers, with `callerHostId` set so host-aware routes (`/context`)
 * scope to the calling host. 404 when no route matched; 500 when the route
 * threw before answering. Never rejects.
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

  const captured: { result?: ControlRelayResult } = {};
  const json = (status: number, body: unknown): void => {
    // A route answers once; keep the first, as an HTTP response would.
    captured.result ??= { status, body };
  };
  // Routes expect an object body, as the HTTP listener's JSON parse gives.
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

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
