/**
 * The routes the remote listener answers itself, rather than dispatching into
 * `electron/routes/`.
 *
 * They exist only for the phone client and they are all authenticated. Two of
 * them read nothing but the calling device; the third reads project
 * *configuration* — never session state — projected down to four fields:
 *
 *   - `GET /me` — the calling device's own label and capability tier, plus the
 *     public half of the push key. No token, no hash, nothing about any other
 *     device. It reports both the tier (ADR-178) and the `canSend` boolean
 *     derived from it, which is what `src/remote-client/main.ts` has always
 *     read — the derived field stays so the small client needs no change and
 *     the two can never disagree.
 *   - `POST /push/subscribe` — store this device's push endpoint.
 *   - `GET /workspaces` — enough of `deps.projectManager.getProjects()` for a
 *     phone to choose a launch target: project name, and each visible
 *     workspace's path, branch and name. It is its own row rather than an
 *     allowlisting of `GET /projects` because `ProjectInfo` also carries
 *     `agentCommand`, `worktreeStartScript`, Linear associations and every
 *     absolute path on the machine — none of which a phone needs to pick a
 *     workspace, and all of which a phone is the wrong place to hold.
 *
 * They are ordinary `Route` rows on purpose. An earlier shape had them as
 * `if (method === … && pathname === …)` blocks inside the request handler with
 * a hand-written list of their keys kept in `allowlist.ts` — two places to
 * update, held together by nobody. `LISTENER_OWN_ROUTES` below is now *derived*
 * from this table, so "what is reachable" is one table and one `dispatch()`.
 *
 * `GET /events` is deliberately not here and cannot be: it hands the raw
 * `ServerResponse` to the SSE hub and keeps it open, and `RouteContext` has no
 * `res`. Widening it would give every route in the table the socket, which is
 * a worse trade than one documented exception in `server.ts`.
 */

import type { Route } from "../routes/types";
import { routeKey } from "./allowlist";
import { canSend, type Capability } from "./devices";
import type { PushManager } from "./push";

/** What the listener's own handlers need that `RouteContext` does not carry. */
export interface ListenerRouteContext {
  device: { id: string; label: string; capability: Capability };
  /** Null disables push entirely; the client then simply never subscribes. */
  push: PushManager | null;
}

export function listenerRoutes({
  device,
  push,
}: ListenerRouteContext): Route[] {
  return [
    {
      method: "GET",
      path: "/me",
      async handler({ json }) {
        json(200, {
          id: device.id,
          label: device.label,
          capability: device.capability,
          // Derived, never stored twice. The remote client (ADR-161/177) reads
          // this and only this; `full` reads as "can send" there because from
          // that client's point of view it is exactly that.
          canSend: canSend(device.capability),
          // The *public* half of the VAPID pair. It is an application server
          // key, not a secret — a client cannot subscribe without it.
          vapidPublicKey: push?.publicKey() ?? null,
        });
      },
    },

    {
      // Subscribing is not a write: being told that a session is blocked is
      // the read surface's whole point, so a read-only device may do it.
      method: "POST",
      path: "/push/subscribe",
      async handler({ json, readBody }) {
        if (!push) {
          json(503, { error: "Push is not available" });
          return;
        }
        const subscription = asSubscription(await readBody());
        if (!subscription) {
          json(400, { error: "Expected a push subscription" });
          return;
        }
        const stored = push.subscribe(device.id, subscription);
        json(
          stored ? 200 : 404,
          stored ? { ok: true } : { error: "Not found" },
        );
      },
    },

    {
      // A read, and a read-only device gets it same as a send-capable one:
      // seeing where a session *could* start is not a write, only launching
      // one is (`POST /agents`, gated separately in `server.ts`).
      method: "GET",
      path: "/workspaces",
      async handler({ deps, json }) {
        const projects = await deps.projectManager.getProjects();
        // Order preserved, not sorted: `getProjects()`'s order is the
        // sidebar's, and the phone should match it.
        const result = projects
          .map((project) => ({
            projectId: project.id,
            projectName: project.name,
            // The phone offers what the sidebar offers, so a hidden workspace
            // is filtered here rather than left for the client to hide.
            workspaces: project.workspaces
              .filter((workspace) => workspace.hidden !== true)
              .map((workspace) => ({
                path: workspace.path,
                branch: workspace.branch,
                name: workspace.name,
                isMain: workspace.isMain,
              })),
          }))
          // A project with nothing visible in it is not a launch target.
          .filter((project) => project.workspaces.length > 0);
        json(200, result);
      },
    },
  ];
}

/**
 * The keys of the table above, asked of the table rather than restated
 * alongside it. The placeholder context is never used for anything — only
 * `method` and `path` are read, and no handler runs.
 */
export const LISTENER_OWN_ROUTES: readonly string[] = listenerRoutes({
  device: { id: "", label: "", capability: "read" },
  push: null,
}).map(routeKey);

/**
 * Validate a subscription body. `endpoint` must be https — a push endpoint is a
 * capability URL, and we will not store one that would be sent in the clear.
 */
function asSubscription(
  body: Record<string, unknown>,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const endpoint = body.endpoint;
  const keys = body.keys;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://"))
    return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length === 0) return null;
  if (typeof auth !== "string" || auth.length === 0) return null;
  return { endpoint, keys: { p256dh, auth } };
}
