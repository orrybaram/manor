/**
 * The allowlist is the ADR-161 control that survives an auth bug, so it is
 * tested against the *real* route table rather than a fixture. Two directions
 * matter and both are asserted: nothing named here may be missing from
 * `routes` (a rename would silently shrink the surface), and nothing dangerous
 * in `routes` may appear on the remote table (a future route must not arrive
 * there by accident).
 *
 * `full` gets exactly the `send` table over HTTP (ADR-182 D2) — its wider
 * reach lives entirely on the bridge, tested in
 * `the bridge's LOCAL_ONLY (ADR-180 D4)` below, not here.
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
import {
  HANDLERS,
  LOCAL_ONLY,
  MUTATING,
  SECRET_FIRST_ARG,
} from "../../bridge/handlers";

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

  it("is a strict subset of the real table for every tier", () => {
    for (const capability of ["read", "send", "full"] as const) {
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
 * The third tier over HTTP (ADR-182 D2). It is not a longer allowlist than
 * `send` and this block exists to keep anyone from making it one: `full`'s
 * wider reach exists only on the bridge, tested in
 * `the bridge's LOCAL_ONLY (ADR-180 D4)` below.
 */
describe("the full tier, over HTTP", () => {
  it("gets exactly the send allowlist, the same Set instance's contents", () => {
    expect(allowedKeys("full")).toEqual(allowedKeys("send"));
  });

  it("gets exactly the send table, row for row", () => {
    expect(keys(remoteRouteTable(routes, "full"))).toEqual(
      keys(remoteRouteTable(routes, "send")),
    );
  });

  it("excludes everything send excludes: any DELETE, layout mutation", () => {
    const full = keys(remoteRouteTable(routes, "full"));
    expect(remoteRouteTable(routes, "full").filter((r) => r.method === "DELETE")).toEqual([]);
    expect(full).not.toContain("POST /tabs");
    expect(full).not.toContain("POST /panes/split");
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
 * Run against `full` too (ADR-182 D2): over HTTP it excludes exactly what
 * `send` excludes.
 */
describe.each(["read", "send", "full"] as const)(
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

  it("is present for a full device, same as a send device", () => {
    expect(keys(remoteRouteTable(routes, "full"))).toContain("POST /agents");
  });

  it("does not put the read half behind the capability", () => {
    expect(keys(remoteRouteTable(routes, "read"))).toContain("GET /agents");
  });
});

/**
 * The handler table's own refusal list (ADR-180 D4). Not a route — a paired
 * `full` device already reaches every route here — but the same idea one
 * layer down: a method absent from `HANDLERS` is refused by not existing, and
 * a method present but named here is refused on purpose, in writing, instead
 * of by an accident of the preload never implementing it. This is the file
 * that already tests "what a device may not do", so it is where that written
 * refusal gets pinned too.
 */
describe("the bridge's LOCAL_ONLY (ADR-180 D4)", () => {
  it("is exactly the methods that name a window or a per-host resource", () => {
    expect([...LOCAL_ONLY].sort()).toEqual(
      [
        // ADR-180 ticket 5: one prewarmed session per host.
        "pty.consumePrewarmed",
        "pty.updatePrewarmCwd",
        // ADR-180 ticket 6: the desk's own viewport file, and the reply half
        // of an app-command addressed to the primary window only.
        "viewport.load",
        "viewport.save",
        "appCommands.result",
        // ADR-180 ticket 7: the keybindings page is read-only on web
        // (ADR-178 ticket 6), and a popout's forwarded command names a
        // window a device does not have.
        "keybindings.set",
        "keybindings.reset",
        "keybindings.resetAll",
        "keybindings.runInMainWindow",
        // ADR-180 ticket 10: the keys, and the lock they turn. A stolen
        // `full` token that can pair more devices is a token that survives
        // its own revocation, and one that can stop the listener can lock the
        // owner out of taking it back. `getStatus` and `refreshDetection` are
        // absent from this list on purpose — a device's settings page may
        // read the surface it is on.
        "remoteControl.setEnabled",
        "remoteControl.pair",
        "remoteControl.revoke",
        "remoteControl.startTunnel",
        "remoteControl.stopTunnel",
        // The one method in the whole surface that takes a raw credential as
        // an argument. Everything else Linear does hands back the result of
        // using the stored key and crosses like any other read.
        "linear.connect",
      ].sort(),
    );
  });

  /**
   * The half of the namespace that is *not* refused. Pinned beside the list
   * above because "read-only on web" is a claim about both halves, and a
   * future edit that widened `LOCAL_ONLY` to the whole namespace would leave
   * a paired device's own settings page unable to say whether the host is
   * reachable — while still passing the assertion above.
   */
  it("leaves remote control's two reads reachable from a device", () => {
    expect(LOCAL_ONLY.has("remoteControl.getStatus")).toBe(false);
    expect(LOCAL_ONLY.has("remoteControl.refreshDetection")).toBe(false);
  });

  /**
   * `MUTATING` decides what lands in the audit log, and `bridgeTarget` puts
   * the first string argument of an audited call in its `target` field. For
   * `linear.connect` that argument is the API key.
   *
   * Asserted over `SECRET_FIRST_ARG` rather than over that one name, because
   * the rule is about the class and not about Linear: a method that *takes* a
   * credential goes in that set, and this is what the set is for.
   * `surface.ts` makes the same assertion at compile time; this one is here
   * because this is the file somebody reads when they want to know what a
   * device may do.
   */
  it("never audits a method whose first argument is a credential", () => {
    expect([...SECRET_FIRST_ARG]).toEqual(["linear.connect"]);
    for (const method of SECRET_FIRST_ARG) {
      expect(MUTATING.has(method)).toBe(false);
    }
  });

  /**
   * The other direction, and the one that would rot silently: every name in
   * `LOCAL_ONLY` has to be a method the table actually has. A refusal for a
   * method that no longer exists refuses nothing, and reads in a diff exactly
   * like one that does.
   */
  it("names only methods that are on the table", () => {
    for (const method of LOCAL_ONLY) {
      expect(Object.keys(HANDLERS)).toContain(method);
    }
  });

  /**
   * What a `full` device's bridge surface *is*, said once: the table, minus
   * the refusals. There is no third list and no per-method gate — `dispatch`
   * looks the method up and asks `LOCAL_ONLY` about the caller's class, and
   * that is the whole of it (ADR-180 D4). The HTTP tiers above are a
   * different mechanism for a different surface; this is the bridge's.
   */
  it("is the whole of what a full device may not reach on the bridge", () => {
    const table = Object.keys(HANDLERS);
    const reachable = table.filter((method) => !LOCAL_ONLY.has(method));
    const refused = table.filter((method) => LOCAL_ONLY.has(method));

    expect(refused.sort()).toEqual([...LOCAL_ONLY].sort());
    expect(reachable).toHaveLength(table.length - LOCAL_ONLY.size);
    // Not a token subset: the reads, the writes and the whole of `pty` are in
    // it, which is ADR-178 D3 as written.
    expect(reachable).toContain("pty.create");
    expect(reachable).toContain("projects.removeWorktree");
    expect(reachable).toContain("git.commit");
    expect(reachable).toContain("remoteControl.getStatus");
  });
});
