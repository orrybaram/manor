/**
 * The allowlist is the ADR-161 control that survives an auth bug, so it is
 * tested against the *real* route table rather than a fixture. Two directions
 * matter and both are asserted: nothing named here may be missing from
 * `routes` (a rename would silently shrink the surface), and nothing dangerous
 * in `routes` may appear on the remote table (a future route must not arrive
 * there by accident).
 *
 * ADR-178 added a third tier for which neither direction applies: a `full`
 * device is handed the whole table. That is asserted here too, in its own
 * block, and — the point of the exercise — every deny-assertion below is run
 * against `read` and `send` by name rather than against "the remote table",
 * so nobody can read a passing suite as saying `full` is narrow.
 */

import { describe, it, expect } from "vitest";
import { routes } from "../../routes/index";
import type { Route } from "../../routes/types";
import {
  allowedKeys,
  REMOTE_READ_ROUTES,
  REMOTE_WRITE_ROUTES,
  remoteRouteTable,
  routeKey,
  unresolvedAllowlistEntries,
} from "../allowlist";
import { LISTENER_OWN_ROUTES } from "../listener-routes";

const keys = (table: readonly Route[]) => table.map(routeKey);

describe("the remote allowlist", () => {
  it("names only routes that really exist", () => {
    expect(unresolvedAllowlistEntries(routes)).toEqual([]);
  });

  it("returns every read route and nothing else for the read tier", () => {
    expect(keys(remoteRouteTable(routes, "read")).sort()).toEqual(
      [...REMOTE_READ_ROUTES].sort(),
    );
  });

  it("adds exactly the write routes for the send tier", () => {
    expect(keys(remoteRouteTable(routes, "send")).sort()).toEqual(
      [...REMOTE_READ_ROUTES, ...REMOTE_WRITE_ROUTES].sort(),
    );
  });

  it("is a strict subset of the real table for read and for send", () => {
    for (const capability of ["read", "send"] as const) {
      const remote = remoteRouteTable(routes, capability);
      const real = new Set(routes);
      for (const route of remote) expect(real.has(route)).toBe(true);
      expect(remote.length).toBeLessThan(routes.length);
    }
  });

  it("reuses the real handler objects rather than redeclaring them", () => {
    for (const route of remoteRouteTable(routes, "send")) {
      const original = routes.find((r) => routeKey(r) === routeKey(route));
      expect(route.handler).toBe(original?.handler);
    }
  });

  it("preserves the match order of the real table", () => {
    const remote = remoteRouteTable(routes, "send");
    const indices = remote.map((r) => routes.indexOf(r));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

/**
 * The third tier (ADR-178 D3). It is not a longer allowlist and this block
 * exists to keep anyone from turning it into one: `allowedKeys` answers `null`
 * — "there is no list" — and the table a `full` device dispatches against is
 * the real one, row for row.
 */
describe("the full tier", () => {
  it("has no allowlist at all", () => {
    expect(allowedKeys("full")).toBeNull();
    expect(allowedKeys("read")).toBeInstanceOf(Set);
    expect(allowedKeys("send")).toBeInstanceOf(Set);
  });

  it("is the entire route table, in order", () => {
    expect(keys(remoteRouteTable(routes, "full"))).toEqual(keys(routes));
  });

  it("carries the real handler objects, not copies of them", () => {
    const remote = remoteRouteTable(routes, "full");
    expect(remote).toHaveLength(routes.length);
    remote.forEach((route, i) => expect(route).toBe(routes[i]));
  });

  it("includes exactly what the other two tiers exclude", () => {
    const full = new Set(keys(remoteRouteTable(routes, "full")));
    for (const key of keys(remoteRouteTable(routes, "send")))
      expect(full.has(key)).toBe(true);
    for (const route of routes) {
      if (route.method === "DELETE")
        expect(full.has(routeKey(route))).toBe(true);
    }
    expect(full.has("POST /tabs")).toBe(true);
    expect(full.has("POST /panes/split")).toBe(true);
  });

  it("hands back a copy, so a caller's wrapping cannot reach the real table", () => {
    const remote = remoteRouteTable(routes, "full");
    remote.length = 0;
    expect(routes.length).toBeGreaterThan(0);
  });
});

describe("the listener's own routes", () => {
  // The list is derived from the table in `listener-routes.ts`, so it cannot go
  // stale the way the hand-written one it replaced could. Pinning it here is
  // what makes *adding* a route the listener answers itself a deliberate,
  // reviewable change rather than an invisible one.
  //
  // `GET /events` is absent on purpose: it keeps the raw socket and so is the
  // one path `server.ts` still answers outside the table. Anything else showing
  // up outside this list is a bug.
  it("are exactly the three routes that go through the table", () => {
    expect([...LISTENER_OWN_ROUTES]).toEqual([
      "GET /me",
      "POST /push/subscribe",
      "GET /workspaces",
    ]);
  });

  it("do not shadow, or duplicate, anything in the real route table", () => {
    const real = new Set(routes.map(routeKey));
    for (const key of LISTENER_OWN_ROUTES) expect(real.has(key)).toBe(false);
  });

  it("are not reachable through the dispatched table, at any tier", () => {
    for (const capability of ["read", "send", "full"] as const) {
      const remote = keys(remoteRouteTable(routes, capability));
      for (const key of LISTENER_OWN_ROUTES) expect(remote).not.toContain(key);
    }
  });
});

/**
 * Deny-assertions. Each line is a family that must stay off the remote
 * surface; widening the allowlist means deleting one of these on purpose.
 */
describe.each(["read", "send"] as const)(
  "the remote table for the %s tier excludes",
  (capability) => {
    const remote = remoteRouteTable(routes, capability);
    const paths = remote.map((r) => r.path);

    it("everything under /projects", () => {
      expect(paths.filter((p) => p.startsWith("/projects"))).toEqual([]);
    });

    it("everything under /issues", () => {
      expect(paths.filter((p) => p.startsWith("/issues"))).toEqual([]);
    });

    /**
     * This assertion also denied `POST /agents` until ADR-177, which deleted
     * that line on purpose — the mechanism this file exists for. Launching is
     * now on a send-capable device's surface, behind `confirmed: true`, an
     * audit line, and `server.ts`'s exact-match check against the workspaces
     * the machine knows. Everything *under* `/agents/` — rename, delete,
     * read-of-one — stays off, and that is what is still asserted here.
     */
    it("acting on one named agent: rename, delete, read-of-one", () => {
      expect(paths.filter((p) => p.startsWith("/agents/"))).toEqual([]);
    });

    it("any DELETE", () => {
      expect(remote.filter((r) => r.method === "DELETE")).toEqual([]);
    });

    it("pane and tab mutation", () => {
      expect(
        keys(remote).filter(
          (k) =>
            k === "POST /tabs" ||
            k === "POST /panes/split" ||
            k.startsWith("POST /panes/"),
        ),
      ).toEqual([]);
    });
  },
);

describe("the read tier", () => {
  it("has no acting route at all", () => {
    const readOnly = keys(remoteRouteTable(routes, "read"));
    for (const key of REMOTE_WRITE_ROUTES) expect(readOnly).not.toContain(key);
  });
});

/**
 * The launch route (ADR-177) is the one row on the send surface that starts a
 * process, so what it is and is not in gets its own block. The capability is the
 * *first* of its four gates and the only one that works by absence: a read-only
 * device does not get a 403 from a row it can see, it gets a table the row was
 * never in.
 */
describe("the launch route", () => {
  it("is absent for a device that can only read", () => {
    expect(keys(remoteRouteTable(routes, "read"))).not.toContain(
      "POST /agents",
    );
  });

  it("is present for a device that can send", () => {
    expect(keys(remoteRouteTable(routes, "send"))).toContain("POST /agents");
  });

  it("is present for a full device, like every other row", () => {
    expect(keys(remoteRouteTable(routes, "full"))).toContain("POST /agents");
  });

  it("does not put the read half behind the capability", () => {
    expect(keys(remoteRouteTable(routes, "read"))).toContain("GET /agents");
  });
});
