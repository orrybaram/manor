/**
 * The box's `manor` CLI, answered by its host server.
 *
 * The CLI on a remote host talks to its daemon's control relay listener
 * which hands each request down the stream of whoever asked
 * for them. That was the desktop, which ran it through its own routes — and
 * so the CLI failed with "Manor desktop is not connected" while the lid was
 * closed. The host server owns this host now, so it asks
 * instead (`enableControlRelay` with `role: "server"`, which a daemon puts
 * ahead of any app) and answers with the routes every server shares
 * (`../routes/server-routes.ts`), over its own deps.
 *
 * What a CLI here may call is still `REMOTE_CONTROL_ALLOWLIST`: projects,
 * workspaces, folders, issues, agents (list, launch) and `/context`. A route
 * that needs a window — panes, tabs, webviews, the browser, the system
 * routes — answers that it needs Manor desktop. To the host every caller is
 * local, and every project is its own.
 *
 * Until the desktop has handed this host over (`ownership: "pending"`)
 * every request is refused, as the server's bridge writes are.
 *
 * The same dispatch answers the desktop's own requests about this host's
 * projects (`hostServer.control`, `answerOwnerRequest`), with no allowlist:
 * the owner may do anything the routes do.
 *
 * Electron-free: the host server bundles it.
 */

import { errorMessage } from "../lib/errors";
import { handleServerControlRequest } from "../routes/server-routes";
import type { ServerRouteDeps } from "../routes/types";
import type {
  ControlRelayResult,
  RelayedControlRequest,
} from "../terminal-host/control-relay-listener";
import type { StreamCommand, StreamEvent } from "../terminal-host/types";
import { PENDING_MESSAGE, type OwnershipState } from "./ownership";

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
 * Every route the box's CLI may call. Data, so widening it is a one-line
 * change. Each entry names one route in `electron/routes/server-routes.ts`
 * (the `:projectId` etc. segments become `ID`); a pathname that matches an
 * entry can only dispatch to that route, since the router matches on method
 * and static segments the same way.
 */
export const REMOTE_CONTROL_ALLOWLIST: readonly RemoteControlRoute[] = [
  // Context: the current workspace
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
 * First path segments of the routes only the desktop answers: they drive a
 * window (panes, tabs, the active workspace, webviews and their recordings)
 * or the desktop's own machine (the system routes). `cli-relay.test.ts`
 * checks this against the desktop's route table.
 */
export const DESKTOP_ONLY_PREFIXES: ReadonlySet<string> = new Set([
  "panes",
  "tabs",
  "workspaces",
  "webview",
  "webviews",
  "recordings",
  "notifications",
  "processes",
  "ports",
  "preferences",
  "theme",
  "stats",
  "remote-control",
  "shell",
  "windows",
  "updater",
]);

/**
 * `pathname` the way the router sees it: it splits on `/` and drops empty
 * segments, so `//projects/` dispatches as `/projects`. Matching the same
 * form keeps the allowlist and the router agreeing on what a path is.
 */
function normalize(pathname: string): string {
  return "/" + pathname.split("/").filter(Boolean).join("/");
}

/** Whether the box's CLI may call `method pathname`. */
export function isRemoteAllowed(method: string, pathname: string): boolean {
  const path = normalize(pathname);
  return REMOTE_CONTROL_ALLOWLIST.some(
    (r) => r.method === method && r.pattern.test(path),
  );
}

/** Routes expect an object body, as the HTTP listener's JSON parse gives. */
function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * Run a request through the server routes and capture its answer. 404 when
 * no route matched; 500 when the route threw before answering (a route that
 * threw after answering keeps its answer). Never rejects.
 */
async function dispatchRequest(
  deps: ServerRouteDeps,
  method: string,
  url: URL,
  body: Record<string, unknown>,
): Promise<ControlRelayResult> {
  const captured: { result?: ControlRelayResult } = {};
  const json = (status: number, answer: unknown): void => {
    // A route answers once; keep the first, as an HTTP response would.
    captured.result ??= { status, body: answer };
  };

  let handled: boolean;
  try {
    // Every caller here is local.
    handled = await handleServerControlRequest(deps, method, url, json, async () => body);
  } catch (err) {
    return captured.result ?? { status: 500, body: { error: errorMessage(err) } };
  }
  if (captured.result) return captured.result;
  if (!handled) {
    return { status: 404, body: { error: `No route for ${method} ${url.pathname}` } };
  }
  return { status: 500, body: { error: `${method} ${url.pathname} sent no response` } };
}

/** A relayed request's path as a URL; null when it is not one. */
function parsePath(path: string): URL | null {
  try {
    return new URL(path, "http://relay");
  } catch {
    return null;
  }
}

/** The refusal until this host is adopted. */
function pending(): ControlRelayResult {
  return {
    status: 503,
    body: { error: `${PENDING_MESSAGE}: connect Manor desktop to it once to finish` },
  };
}

export interface CliRelayDeps {
  routes: ServerRouteDeps;
  ownership: Pick<OwnershipState, "current">;
}

/**
 * Answer one request from the box's CLI: 503 until adopted, 403 off the
 * allowlist (saying so when the route needs Manor desktop), otherwise
 * whatever the route answers. Never rejects.
 */
export async function answerCliRequest(
  deps: CliRelayDeps,
  req: RelayedControlRequest,
): Promise<ControlRelayResult> {
  if (deps.ownership.current() !== "host") return pending();
  const method = req.method.toUpperCase();
  const url = parsePath(req.path);
  if (!url) return { status: 400, body: { error: `Invalid path: ${req.path}` } };
  if (!isRemoteAllowed(method, url.pathname)) {
    const [first = ""] = url.pathname.split("/").filter(Boolean);
    const what = `${method} ${normalize(url.pathname)}`;
    return {
      status: 403,
      body: {
        error: DESKTOP_ONLY_PREFIXES.has(first)
          ? `${what} needs Manor desktop; it isn't available from remote hosts`
          : `${what} isn't available from remote hosts`,
      },
    };
  }
  return dispatchRequest(deps.routes, method, url, objectBody(req.body));
}

/**
 * Answer the desktop's request about one of this host's projects or agents
 * (`hostServer.control`): any server route, no allowlist. 503 until
 * adopted. Never rejects.
 */
export async function answerOwnerRequest(
  deps: CliRelayDeps,
  req: RelayedControlRequest,
): Promise<ControlRelayResult> {
  if (deps.ownership.current() !== "host") return pending();
  const url = parsePath(req.path);
  if (!url) return { status: 400, body: { error: `Invalid path: ${req.path}` } };
  return dispatchRequest(deps.routes, req.method.toUpperCase(), url, objectBody(req.body));
}

/** The daemon client's side of the relay that `serveCliRelay` uses. */
export interface CliRelayClient {
  onStreamConnected(handler: () => void): () => void;
  onEvent(handler: (event: StreamEvent) => void): () => void;
  sendStreamCommand(cmd: StreamCommand): boolean;
}

/**
 * Claim the daemon's control relay for this server and answer what it
 * relays. The daemon relays to the socket that last asked and
 * forgets one that closes, so every new stream socket asks again. Returns
 * the release.
 */
export function serveCliRelay(client: CliRelayClient, deps: CliRelayDeps): () => void {
  const offConnected = client.onStreamConnected(() => {
    client.sendStreamCommand({ type: "enableControlRelay", role: "server" });
  });
  const offEvent = client.onEvent((event) => {
    if (event.type !== "controlRequest") return;
    const { id, method, path, body } = event;
    void answerCliRequest(deps, { method, path, body })
      .catch((err: unknown): ControlRelayResult => ({
        status: 500,
        body: { error: errorMessage(err) },
      }))
      .then((result) => {
        // An answer that outlives its stream goes to the new socket, which the
        // daemon ignores; the CLI already had its 503.
        client.sendStreamCommand({ type: "controlResponse", id, ...result });
      });
  });
  return () => {
    offConnected();
    offEvent();
  };
}
