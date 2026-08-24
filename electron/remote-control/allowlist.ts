/**
 * The list of `electron/routes/` rows that may ever be reached from outside
 * this machine.
 *
 * `WebviewServer` binds loopback and authenticates nothing — loopback *is* its
 * boundary, and that is fine for MCP and the CLI. The remote-control listener
 * (ADR-161) has no such boundary, so it is handed a filtered table rather than
 * `routes`. A route that is not named here is **absent** from the table the
 * remote listener dispatches against, not 403'd: an auth bug cannot reach a
 * row that was never there.
 *
 * Adding a line to either array is a security decision, and
 * `__tests__/allowlist.test.ts` is written to make that deliberate — it asserts
 * both that every name resolves to a real route and that whole families of
 * routes (`/projects`, `/issues`, agent launch, any `DELETE`) stay off the
 * surface, so widening it means consciously deleting a test line.
 */

import type { Route } from "../routes/types";

/**
 * Read-only rows. Note what is *not* here: `POST /agents` launches a process
 * and `POST /tabs`/`POST /panes/split` mutate layout, so neither is a read
 * despite living under an otherwise-readable prefix. The session list the
 * mobile client renders is `GET /tasks`; there is no `GET /agents` route.
 */
export const REMOTE_READ_ROUTES = [
  "GET /tasks",
  "GET /context",
  "GET /panes",
  "POST /sessions/read",
] as const;

/**
 * Rows that can act. Present in the table only for a device that holds the
 * send capability — see `remoteRouteTable`'s `allowWrites` and ticket 4's
 * confirmation and audit gates, which sit on top of this.
 *
 * `/sessions/interrupt` is a write and is gated identically, even though it
 * says nothing to the agent: stopping a turn discards whatever it was in the
 * middle of. It is separate from `/sessions/send` (which interrupts as a
 * side effect of injecting a prompt) so that "make it stop" is reachable
 * without having to say something, and so the audit trail can tell the two
 * apart.
 */
export const REMOTE_WRITE_ROUTES = [
  "POST /sessions/send",
  "POST /sessions/interrupt",
] as const;

/**
 * A third group exists and is *not* declared here: the paths the listener
 * answers itself rather than dispatching into `electron/routes/`. They live in
 * `./listener-routes.ts` as ordinary `Route` rows, and `LISTENER_OWN_ROUTES`
 * there is derived from that table so the two cannot drift. Read both files to
 * know the whole surface; there is no third.
 */

/** The `"METHOD /path"` key both allowlists are written in. */
export function routeKey(route: Route): string {
  return `${route.method} ${route.path}`;
}

/** Every allowlisted key, with the write rows included only if allowed. */
export function allowedKeys(allowWrites: boolean): Set<string> {
  return new Set<string>(
    allowWrites
      ? [...REMOTE_READ_ROUTES, ...REMOTE_WRITE_ROUTES]
      : REMOTE_READ_ROUTES,
  );
}

/**
 * Filter the real route table down to the remote surface.
 *
 * Deliberately a filter over `all` rather than a table built here: the handlers
 * are written once, in `electron/routes/`, and the remote listener reuses them
 * through the same `dispatch()`. Match order is preserved, so the ordering
 * hazards `router.test.ts` checks for cannot be reintroduced by filtering.
 */
export function remoteRouteTable(
  all: readonly Route[],
  allowWrites: boolean,
): Route[] {
  const allowed = allowedKeys(allowWrites);
  return all.filter((route) => allowed.has(routeKey(route)));
}

/**
 * Allowlist entries that name no route in `all` — a typo or a renamed path.
 * The test turns a non-empty result into a failure so the remote surface can
 * never silently shrink to nothing.
 */
export function unresolvedAllowlistEntries(all: readonly Route[]): string[] {
  const real = new Set(all.map(routeKey));
  return [...REMOTE_READ_ROUTES, ...REMOTE_WRITE_ROUTES].filter(
    (key) => !real.has(key),
  );
}
