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
 *   3. rate-limit check, then `devices.verify()` — a failure returns 401
 *      **before the body is read** and before any handler exists;
 *   4. `Origin`/`Host` agreement, as defence in depth only. This is a
 *      browser-enforced control and `curl` does not enforce it, so it is never
 *      the boundary;
 *   5. dispatch against `remoteRouteTable(routes, device.canSend)` — a table
 *      that never contained the dangerous routes in the first place.
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
import { hashText, RemoteAuditLog } from "./audit";
import { AuthRateLimiter } from "./rate-limit";
import { SseHub } from "./sse";

/** What the listener needs of a device. `RemoteDeviceStore` satisfies it. */
export interface AuthenticatedDevice {
  id: string;
  label: string;
  canSend: boolean;
}

export interface DeviceVerifier {
  verify(rawToken: unknown): AuthenticatedDevice | null;
}

/** One agent-status change, as the client's session list consumes it. */
export interface RemoteStatusEvent {
  taskId: string;
  name: string | null;
  projectName: string | null;
  status: string | null;
  previousStatus: string | null;
}

/** The only acting route on the surface. Wrapped, never reached bare. */
const SEND_ROUTE = "POST /sessions/send";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** No allowlisted route uses anything else, so nothing else gets past step 1. */
const ALLOWED_METHODS = new Set(["GET", "POST"]);

export class RemoteControlServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly hub = new SseHub();

  constructor(
    private readonly getDeps: () => ControlDeps,
    private readonly devices: DeviceVerifier,
    private readonly limiter: AuthRateLimiter = new AuthRateLimiter(),
    private readonly audit: RemoteAuditLog = new RemoteAuditLog(),
  ) {}

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

    // ── 2 & 3. Authenticate before anything else happens ──
    const source = req.socket.remoteAddress ?? "unknown";
    const retryAfter = this.limiter.retryAfterMs(source);
    if (retryAfter > 0) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfter / 1000)),
      });
      res.end(JSON.stringify({ error: "Too many attempts" }));
      return;
    }

    const device = this.devices.verify(bearerToken(req));
    if (!device) {
      const delay = this.limiter.recordFailure(source);
      // Loud on purpose: a knock on this listener is worth seeing. The
      // presented token is never logged, in any form.
      console.warn(
        `[remote-control] rejected request from ${source} ` +
          `(${this.limiter.failureCount(source)} consecutive, backing off ${delay}ms)`,
      );
      json(401, { error: "Unauthorized" });
      return;
    }
    this.limiter.recordSuccess(source);

    // ── 4. Origin/Host agreement — defence in depth, never the boundary ──
    if (!originAgrees(req)) {
      json(403, { error: "Forbidden" });
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");

    // ── 5. Routing, against a table the dangerous routes were never in ──
    if (method === "GET" && url.pathname === "/events") {
      this.hub.add(device.id, res);
      return;
    }

    const readBody = makeReadBody(req);
    const table = this.guardWrites(
      remoteRouteTable(routes, device.canSend),
      device,
    );
    const ownedPrefixes = new Set(table.map((r) => r.path.split("/")[1]));

    const matched = await dispatch(
      table,
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
   * Wrap the send route without touching `electron/routes/tasks.ts` — the local
   * MCP path must keep working exactly as it does, so the confirmation and the
   * audit line are remote-only concerns and live here.
   *
   * This is the *third* gate. The first is the table: a device without
   * `canSend` never sees this route at all, so nothing below is what stops it.
   */
  private guardWrites(table: Route[], device: AuthenticatedDevice): Route[] {
    return table.map((route) =>
      routeKey(route) === SEND_ROUTE
        ? {
            ...route,
            handler: (ctx: RouteContext) =>
              this.guardedSend(route, device, ctx),
          }
        : route,
    );
  }

  private async guardedSend(
    route: Route,
    device: AuthenticatedDevice,
    ctx: RouteContext,
  ): Promise<void> {
    const body = await ctx.readBody();
    const target = typeof body.target === "string" ? body.target : null;
    const text = typeof body.text === "string" ? body.text : null;
    const interrupt = typeof body.interrupt === "string";

    const line = (
      outcome: RemoteAuditEntryOutcome,
      status: number,
      reason?: string,
    ) =>
      this.audit.append({
        at: new Date().toISOString(),
        deviceId: device.id,
        deviceLabel: device.label,
        route: SEND_ROUTE,
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
    // distinguishes from a confirmed send made through the UI.
    if (body.confirmed !== true) {
      line("rejected", 400, "missing confirmed:true");
      ctx.json(400, {
        error: "A remote send must set 'confirmed': true",
      });
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
    line(status === 200 ? "sent" : "rejected", status);
  }
}

type RemoteAuditEntryOutcome = "sent" | "rejected" | "failed";

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
