/**
 * The allowlist is the ADR-161 control that survives an auth bug, so it is
 * tested against the *real* route table rather than a fixture. Two directions
 * matter and both are asserted: nothing named here may be missing from
 * `routes` (a rename would silently shrink the surface), and nothing dangerous
 * in `routes` may appear on the remote table (a future route must not arrive
 * there by accident).
 */

import { describe, it, expect } from "vitest";
import { routes } from "../../routes/index";
import type { Route } from "../../routes/types";
import {
  LISTENER_OWN_ROUTES,
  REMOTE_READ_ROUTES,
  REMOTE_WRITE_ROUTES,
  remoteRouteTable,
  routeKey,
  unresolvedAllowlistEntries,
} from "../allowlist";

const keys = (table: readonly Route[]) => table.map(routeKey);

describe("the remote allowlist", () => {
  it("names only routes that really exist", () => {
    expect(unresolvedAllowlistEntries(routes)).toEqual([]);
  });

  it("returns every read route and nothing else when writes are off", () => {
    expect(keys(remoteRouteTable(routes, false)).sort()).toEqual(
      [...REMOTE_READ_ROUTES].sort(),
    );
  });

  it("adds exactly the write routes when writes are on", () => {
    expect(keys(remoteRouteTable(routes, true)).sort()).toEqual(
      [...REMOTE_READ_ROUTES, ...REMOTE_WRITE_ROUTES].sort(),
    );
  });

  it("is a strict subset of the real table", () => {
    const remote = remoteRouteTable(routes, true);
    const real = new Set(routes);
    for (const route of remote) expect(real.has(route)).toBe(true);
    expect(remote.length).toBeLessThan(routes.length);
  });

  it("reuses the real handler objects rather than redeclaring them", () => {
    for (const route of remoteRouteTable(routes, true)) {
      const original = routes.find((r) => routeKey(r) === routeKey(route));
      expect(route.handler).toBe(original?.handler);
    }
  });

  it("preserves the match order of the real table", () => {
    const remote = remoteRouteTable(routes, true);
    const indices = remote.map((r) => routes.indexOf(r));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

describe("the listener's own routes", () => {
  it("do not shadow, or duplicate, anything in the real route table", () => {
    const real = new Set(routes.map(routeKey));
    for (const key of LISTENER_OWN_ROUTES) expect(real.has(key)).toBe(false);
  });

  it("are not reachable through the dispatched table", () => {
    const remote = keys(remoteRouteTable(routes, true));
    for (const key of LISTENER_OWN_ROUTES) expect(remote).not.toContain(key);
  });
});

/**
 * Deny-assertions. Each line is a family that must stay off the remote
 * surface; widening the allowlist means deleting one of these on purpose.
 */
describe("the remote table excludes", () => {
  const remote = remoteRouteTable(routes, true);
  const paths = remote.map((r) => r.path);

  it("everything under /projects", () => {
    expect(paths.filter((p) => p.startsWith("/projects"))).toEqual([]);
  });

  it("everything under /issues", () => {
    expect(paths.filter((p) => p.startsWith("/issues"))).toEqual([]);
  });

  it("agent launching", () => {
    expect(
      paths.filter((p) => p === "/agents" || p.startsWith("/agents/")),
    ).toEqual([]);
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

  it("every route that is not read-only unless writes are enabled", () => {
    const readOnly = remoteRouteTable(routes, false);
    expect(keys(readOnly)).not.toContain("POST /sessions/send");
  });
});
