/**
 * The authenticated remote-control listener (ADR-161 §1–§3).
 *
 * A *second* `http.Server`, separate from `WebviewServer` by design.
 * `WebviewServer` authenticates nothing and does not need to: loopback is its
 * boundary and its exposure is not changing. This one is reachable through a
 * tunnel, so it gets its own threat model rather than a mode flag on the
 * existing listener — the failure mode of a mode flag is one route that forgot
 * to check it.
 *
 * The request pipeline order is the security property, and must not be
 * rearranged:
 *
 *   1. method and declared size sanity;
 *   2. bearer token out of `Authorization`;
 *   3. `devices.verify()`, then — only if it failed — the rate-limit check. A
 *      failure returns 401 (or 429) **before the body is read** and before any
 *      handler exists. Verification comes first so that a backoff earned by
 *      someone else guessing through the same tunnel can never reject a device
 *      holding a valid token;
 *   4. `Origin`/`Host` agreement, as defence in depth only. This is a
 *      browser-enforced control and `curl` does not enforce it, so it is never
 *      the boundary;
 *   5. dispatch against `remoteRouteTable(routes, device.capability)` — for
 *      `read` and `send`, a table that never contained the dangerous routes in
 *      the first place. For `full` (ADR-178 D3) it is the whole table, and
 *      step 3 is the only boundary there is; every non-GET row is wrapped in
 *      an audit line instead.
 *
 * It binds `127.0.0.1` even when enabled. Reaching it from outside is the
 * tunnel's job (`./tunnel.ts`), which is a separate, explicit user action.
 */

import http from "node:http";

import { routes } from "../routes/index";
import { dispatch } from "../routes/router";
import type {
  ControlDeps,
  Json,
  ReadBody,
  Route,
  RouteContext,
} from "../routes/types";
import { remoteRouteTable, routeKey } from "./allowlist";
import type { Capability } from "./devices";
import { listenerRoutes } from "./listener-routes";
import { hashText, RemoteAuditLog } from "./audit";
import type { PushManager } from "./push";
import { AuthRateLimiter } from "./rate-limit";
import { SseHub } from "./sse";
import {
  defaultClientDir,
  defaultWebDir,
  serveClientAsset,
  serveWebAsset,
} from "./static";

/** What the listener needs of a device. `RemoteDeviceStore` satisfies it. */
export interface AuthenticatedDevice {
  id: string;
  label: string;
  capability: Capability;
}

export interface DeviceVerifier {
  verify(rawToken: unknown): AuthenticatedDevice | null;
}

/** One agent-status change, as the client's session list consumes it. */
export interface RemoteStatusEvent {
  agentId: string;
  name: string | null;
  projectName: string | null;
  status: string | null;
  previousStatus: string | null;
}

/** The acting routes on the surface. Wrapped, never reached bare. */
const SEND_ROUTE = "POST /sessions/send";
const INTERRUPT_ROUTE = "POST /sessions/interrupt";
/** Launching (ADR-177) — the only guarded write that starts a process. */
const LAUNCH_ROUTE = "POST /agents";
const GUARDED_WRITE_ROUTES = new Set([
  SEND_ROUTE,
  INTERRUPT_ROUTE,
  LAUNCH_ROUTE,
]);

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The three methods `Route` can declare. Anything else is not a route this
 * machine has, whatever the tier, so it dies at step 1 — before authentication
 * and before a body is read.
 *
 * `DELETE` is here for the `full` tier only (ADR-178). For `read` and `send`
 * the table still contains no `DELETE` row, so such a request falls through to
 * a 404: absent, as it always was, rather than the 405 this set used to give.
 */
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);

/**
 * The collaborators that have a sensible default. Named rather than positional
 * because the only caller that overrides the last one would otherwise have to
 * pass `undefined` three times to reach it.
 */
export interface RemoteControlServerOptions {
  limiter?: AuthRateLimiter;
  audit?: RemoteAuditLog;
  /**
   * Built client directory. Omit for the bundled one; pass `null` to serve no
   * page at all (tests, and dev before a build).
   */
  clientDir?: string | null;
  /**
   * Built web-app directory (ADR-178), served at `/app`. Omit for the
   * bundled one; pass `null` to serve no page at all (tests, and dev before
   * a build).
   */
  webDir?: string | null;
  /** Null disables push entirely; the client then simply never subscribes. */
  push?: PushManager | null;
}

export class RemoteControlServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly hub = new SseHub();

  private readonly limiter: AuthRateLimiter;
  private readonly audit: RemoteAuditLog;
  private readonly clientDir: string | null;
  private readonly webDir: string | null;
  private readonly push: PushManager | null;

  constructor(
    private readonly getDeps: () => ControlDeps,
    private readonly devices: DeviceVerifier,
    options: RemoteControlServerOptions = {},
  ) {
    this.limiter = options.limiter ?? new AuthRateLimiter();
    this.audit = options.audit ?? new RemoteAuditLog();
    // Not `??`: an explicit `null` means "serve no page at all", which is a
    // different thing from "not specified, use the built one".
    this.clientDir =
      options.clientDir === undefined ? defaultClientDir() : options.clientDir;
    this.webDir =
      options.webDir === undefined ? defaultWebDir() : options.webDir;
    this.push = options.push ?? null;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get serverPort(): number {
    return this.port;
  }

  /** Live SSE connections — the UI's "someone is watching" signal. */
  get listenerCount(): number {
    return this.hub.size;
  }

  async start(): Promise<{ port: number }> {
    if (this.server) return { port: this.port };

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error("[remote-control] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        } else {
          res.end();
        }
      });
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;

    this.limiter.start();

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      // Loopback, always. Exposure is the tunnel's decision, never this one's.
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.server = server;
        const addr = server.address();
        this.port = addr && typeof addr === "object" ? addr.port : 0;
        resolve({ port: this.port });
      });
    });
  }

  /** Closes the listener *and* every open stream — an SSE socket holds it open. */
  async stop(): Promise<void> {
    this.hub.closeAll();
    this.limiter.stop();
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    // `close()` waits for open connections to end, and a keep-alive socket
    // would hold a "stopped" listener open indefinitely. Disabling remote
    // control has to actually stop answering.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Fan a status transition out to connected phones. Called from the same
   * signal that already drives the dock badge and OS notifications — this is a
   * second sink, not a second detector.
   */
  publishStatus(event: RemoteStatusEvent): void {
    this.hub.broadcast("status", event);
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const json: Json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        // Nothing here is meant to be cached by anything in the tunnel path.
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };

    // ── 1. Method and declared size ──
    const method = req.method ?? "GET";
    if (!ALLOWED_METHODS.has(method)) {
      json(405, { error: "Method not allowed" });
      return;
    }
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      json(413, { error: "Request body too large" });
      return;
    }
    if (!req.url) {
      json(404, { error: "Not found" });
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");

    // ── 1b. The app shells, before auth and on purpose ──
    // The pairing token rides in the URL fragment, which never reaches the
    // server, so the page has to load unauthenticated and present its token
    // from JavaScript. Only static files are reachable this way; see
    // `static.ts`. Nothing below this line is.
    if (
      method === "GET" &&
      serveClientAsset(res, url.pathname, this.clientDir)
    ) {
      return;
    }
    if (
      method === "GET" &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/")) &&
      serveWebAsset(res, url.pathname, this.webDir)
    ) {
      return;
    }

    // ── 2 & 3. Authenticate before anything else happens ──
    //
    // Verification comes *before* the backoff check, and that order is the
    // whole point. This listener binds loopback, so every request arriving
    // through a tunnel has `127.0.0.1` as its peer — one bucket shared by every
    // remote device and every stranger who found the hostname. Checking the
    // backoff first meant a guesser could drive that shared bucket into
    // exponential delay and the owner's phone, holding a perfectly good token,
    // got the 429. A control meant to slow an intruder down was locking the
    // owner out instead.
    //
    // So: a valid token is served no matter what anyone else has been doing,
    // and the backoff applies only to requests that failed to authenticate.
    // The cost of that ordering is one SHA-256 and a `timingSafeEqual` per
    // request from a source that is already blocked, which is not a price
    // worth an availability bug.
    const source = req.socket.remoteAddress ?? "unknown";
    const presented = bearerToken(req);
    const device = presented === null ? null : this.devices.verify(presented);

    if (!device) {
      const retryAfter = this.limiter.retryAfterMs(source);
      if (retryAfter > 0) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(retryAfter / 1000)),
        });
        res.end(JSON.stringify({ error: "Too many attempts" }));
        return;
      }
      // Only a request that actually presented a token counts as an attempt.
      // A browser asks for `/favicon.ico` with no `Authorization` header the
      // moment the page loads, and penalising that would back the address off
      // before the app's own first call. Guessing still costs, because
      // guessing means sending a token.
      if (presented !== null) {
        const delay = this.limiter.recordFailure(source);
        // Loud on purpose: a knock on this listener is worth seeing. The
        // presented token is never logged, in any form.
        console.warn(
          `[remote-control] rejected request from ${source} ` +
            `(${this.limiter.failureCount(source)} consecutive, backing off ${delay}ms)`,
        );
      }
      json(401, { error: "Unauthorized" });
      return;
    }
    this.limiter.recordSuccess(source);

    // ── 4. Origin/Host agreement — defence in depth, never the boundary ──
    if (!originAgrees(req)) {
      json(403, { error: "Forbidden" });
      return;
    }

    // One reader per request: it memoizes, so the send wrapper and the handler
    // it wraps both see the same body.
    const readBody = makeReadBody(req);

    // ── 5. Routing, against a table the dangerous routes were never in ──
    // One table, one dispatch. `listenerRoutes` are the rows this listener
    // answers itself — see `./listener-routes.ts` for why they are rows and
    // not conditionals, and why `/events` below cannot be one.
    if (method === "GET" && url.pathname === "/events") {
      this.hub.add(device.id, res);
      return;
    }

    const table = [
      ...listenerRoutes({ device, push: this.push }),
      ...this.guardWrites(remoteRouteTable(routes, device.capability), device),
    ];
    const ownedPrefixes = new Set(table.map((r) => r.path.split("/")[1]));

    // Filter by method *before* dispatch: `GET /agents` is on every device's
    // surface and `POST /agents` (launch) is on only a send-capable one's, so a
    // read-only device asking to launch would otherwise get a 405 that reveals
    // the row exists. With only same-method rows in the table, a write route
    // this device does not hold falls through to the plain 404 below.
    const matched = await dispatch(
      table.filter((r) => r.method === method),
      ownedPrefixes,
      this.getDeps(),
      method,
      url,
      json,
      readBody,
    );
    // A route that is not on the remote surface is *absent*, so it lands here
    // as a plain 404 — the client cannot tell an unrouted path from one this
    // build never exposes, and no auth bug can reach a handler that was never
    // in the table.
    if (!matched) json(404, { error: "Not found" });
  }

  /**
   * Wrap the acting routes without touching `electron/routes/agents.ts` — the
   * local MCP path must keep working exactly as it does, so the confirmation
   * and the audit line are remote-only concerns and live here.
   *
   * For a `send` device this is the *third* gate. The first is the table: a
   * device without the send capability never sees these routes at all, so
   * nothing below is what stops it. `LAUNCH_ROUTE` gets a fourth — the
   * workspace must be one the machine knows (ADR-177) — because it starts a
   * process rather than typing at one.
   *
   * For a `full` device there is no first gate to lean on: `remoteRouteTable`
   * handed back the whole table. So the rule is the blunt one — every route
   * whose method is not `GET` gets an audit line, and none of them asks for
   * `confirmed`. Asking would be theatre: the thing calling these is the
   * desktop app running in a browser, and its own confirmation dialogs already
   * stand in front of every destructive action. What is owed instead is a
   * record, and that is what this writes.
   */
  private guardWrites(table: Route[], device: AuthenticatedDevice): Route[] {
    if (device.capability === "full") {
      return table.map((route) =>
        route.method === "GET"
          ? route
          : {
              ...route,
              handler: (ctx: RouteContext) =>
                this.fullTierWrite(routeKey(route), route, device, ctx),
            },
      );
    }
    return table.map((route) => {
      const key = routeKey(route);
      return GUARDED_WRITE_ROUTES.has(key)
        ? {
            ...route,
            handler: (ctx: RouteContext) =>
              this.guardedWrite(key, route, device, ctx),
          }
        : route;
    });
  }

  /**
   * Run a `full` device's write and record that it happened.
   *
   * Nothing is refused here — the tier's whole definition is that
   * authentication was the boundary. The line names the route and what it was
   * aimed at, and stops there: no text, no hash. Every one of the desktop's
   * ~100 routes takes a differently shaped body, and an audit log that went
   * fishing through all of them would eventually land on one carrying a
   * credential. Only the two field names the remote surface already trusted
   * (`target`, `workspacePath`) are read, and otherwise the target is whatever
   * the path itself captured.
   */
  private async fullTierWrite(
    key: string,
    route: Route,
    device: AuthenticatedDevice,
    ctx: RouteContext,
  ): Promise<void> {
    const target = await this.fullTierTarget(ctx);

    const line = (outcome: RemoteAuditEntryOutcome, status: number) =>
      this.audit.append({
        at: new Date().toISOString(),
        deviceId: device.id,
        deviceLabel: device.label,
        tier: "full",
        route: key,
        target,
        textLength: null,
        textSha256: null,
        interrupt: key === INTERRUPT_ROUTE,
        outcome,
        status,
      });

    let status = 0;
    const json: Json = (s, b) => {
      status = s;
      ctx.json(s, b);
    };

    try {
      await route.handler({ ...ctx, json });
    } catch (err) {
      line("failed", 500);
      throw err;
    }
    line(outcomeFor(status), status);
  }

  /**
   * What a `full` device's write was aimed at, for the audit line.
   *
   * Body first, path second: `POST /sessions/send` names its target in the
   * body while `DELETE /panes/:paneId` names it in the path, and the line
   * should read the same way for both. `readBody()` is memoized by
   * `makeReadBody`, so the handler below still gets the same parse rather than
   * a consumed socket — and a body that never arrives or does not parse costs
   * the line its target, never the request.
   */
  private async fullTierTarget(ctx: RouteContext): Promise<string | null> {
    try {
      const body = await ctx.readBody();
      if (typeof body.target === "string") return body.target;
      if (typeof body.workspacePath === "string") return body.workspacePath;
    } catch {
      // Fall through to the path.
    }
    const captured = Object.values(ctx.params);
    return captured.length > 0 ? captured.join("/") : null;
  }

  private async guardedWrite(
    key: string,
    route: Route,
    device: AuthenticatedDevice,
    ctx: RouteContext,
  ): Promise<void> {
    const body = await ctx.readBody();
    // One audit shape, two vocabularies: a send names a `target` and carries
    // `text`, a launch names a `workspacePath` and carries a `prompt`. Read both
    // so a launch audits as the thing it acted on and the text it typed, rather
    // than as two nulls — and so the prompt is hashed by exactly the code that
    // hashes a send's text. Neither is ever recorded in the clear.
    const target =
      typeof body.target === "string"
        ? body.target
        : typeof body.workspacePath === "string"
          ? body.workspacePath
          : null;
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.prompt === "string"
          ? body.prompt
          : null;
    // True for the interrupt route by definition, and for a send that carried
    // an override of the interrupt sequence. A launch is neither — it is a new
    // pane, and a new pane interrupts nothing — so this yields false for it
    // without needing a case of its own.
    const interrupt =
      key === INTERRUPT_ROUTE || typeof body.interrupt === "string";

    const line = (
      outcome: RemoteAuditEntryOutcome,
      status: number,
      reason?: string,
    ) =>
      this.audit.append({
        at: new Date().toISOString(),
        deviceId: device.id,
        deviceLabel: device.label,
        tier: "send",
        route: key,
        target,
        textLength: text === null ? null : text.length,
        textSha256: text === null ? null : hashText(text),
        interrupt,
        outcome,
        status,
        ...(reason ? { reason } : {}),
      });

    // Gate two: an explicit opt-in *in the request*. The client shows the text
    // and the target before setting it (ticket 6/7), and a bare `curl` holding
    // a stolen token still has to say it meant to — which the audit trail then
    // distinguishes from a confirmed action made through the UI. It applies to
    // an interrupt too: stopping a turn throws away whatever it was doing.
    if (body.confirmed !== true) {
      line("rejected", 400, "missing confirmed:true");
      ctx.json(400, {
        error: "A remote write must set 'confirmed': true",
      });
      return;
    }

    // Gate four, and the only one that exists for a single route: a remote
    // launch may only target a workspace this machine already knows about. See
    // `knownWorkspacePaths`.
    if (key === LAUNCH_ROUTE && !(await this.isKnownWorkspace(target))) {
      line("rejected", 403, `unknown workspace: ${target ?? "(none given)"}`);
      // The body says nothing about what *would* have matched. A phone that
      // needs the list asks `GET /workspaces` for it; a caller guessing paths
      // learns nothing from a rejection.
      ctx.json(403, { error: "Unknown workspace" });
      return;
    }

    let status = 0;
    const json: Json = (s, b) => {
      status = s;
      ctx.json(s, b);
    };

    try {
      // `route.handler` is the real handler — `guardWrites` built a new row and
      // closed over the original, so this is not the wrapper again.
      await route.handler({ ...ctx, json });
    } catch (err) {
      line("failed", 500, "handler threw");
      throw err;
    }
    line(outcomeFor(status), status);
  }

  /**
   * Is this the path of a workspace the machine already knows?
   *
   * `POST /agents` itself (`electron/routes/agents.ts`) accepts any
   * `workspacePath` string and lets the renderer resolve it, which is right for
   * the loopback callers — MCP and the CLI legitimately launch into a directory
   * that is not in a project yet, and they already own the machine. Over a
   * tunnel it is not right, so the narrowing lives here with the other
   * remote-only concerns rather than in the route.
   *
   * Exact equality, never a prefix test: a prefix would accept
   * `/Users/me/manor/../../etc` and every other traversal dressed as a known
   * workspace, and it buys nothing — every legitimate target is a path the phone
   * read verbatim from `GET /workspaces`. Hidden workspaces count as known: the
   * property being enforced is "a directory the user already told Manor about",
   * not "a row the phone was offered".
   *
   * No `projectManager` means no known paths, which means no remote launch. A
   * `getProjects()` that throws is the same answer for the same reason — the
   * check cannot be allowed to fail open, and a throw here would otherwise
   * escape as a 500 with no audit line.
   */
  private async isKnownWorkspace(requested: string | null): Promise<boolean> {
    if (requested === null) return false;
    const projectManager = this.getDeps().projectManager;
    if (!projectManager) return false;
    try {
      const projects = await projectManager.getProjects();
      return projects.some((project) =>
        project.workspaces.some((workspace) => workspace.path === requested),
      );
    } catch (err) {
      console.error(
        "[remote-control] could not read workspaces; refusing launch:",
        err,
      );
      return false;
    }
  }
}

type RemoteAuditEntryOutcome = "sent" | "rejected" | "failed";

/**
 * How a completed handler reads in the trail. 2xx is the whole success range —
 * the acting routes all answer 200, but a `full` device reaches rows that
 * answer 201 or 204, and those are not rejections.
 */
function outcomeFor(status: number): RemoteAuditEntryOutcome {
  return status >= 200 && status < 300 ? "sent" : "rejected";
}

/** The raw bearer token, or null. Never logged by any caller. */
function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * A browser sends `Origin` on cross-origin requests; a request that carries one
 * naming a different host than it is addressed to is a cross-site call, which
 * nothing legitimate here makes. `curl` simply omits the header — hence
 * "defence in depth" and not "the check".
 */
function originAgrees(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "" || origin === "null")
    return true;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Body reader with a hard byte cap enforced while streaming, not after — a
 * `Content-Length` header is a claim, and the socket is what actually arrives.
 */
function makeReadBody(req: http.IncomingMessage): ReadBody {
  // Memoized: a socket can only be drained once, and the send wrapper needs to
  // inspect the body before handing it to the handler that also reads it.
  let pending: Promise<Record<string, unknown>> | null = null;
  return () => {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf-8");
          const parsed: unknown = text ? JSON.parse(text) : {};
          if (typeof parsed !== "object" || parsed === null) {
            resolve({});
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
    return pending;
  };
}
