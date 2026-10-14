/**
 * The routing surface (ADR-227 D4): which shared methods the desktop answers
 * through a remote host's server.
 *
 * A missing `route` is silent — the call runs here, against a host whose
 * records are not here any more — so every method of a namespace that holds
 * host state has to say where it runs: a `RouteRule`, or `LOCAL_ROUTE` for
 * one the desktop answers whatever host it touches (a merged read, a write
 * that fans out itself). And a method routed to a host is only useful if
 * the host's table answers it.
 */

import { describe, expect, it } from "vitest";

import { DESKTOP_TABLE } from "../handlers";
import { SERVER_METHODS } from "../server-methods";
import { LOCAL_ROUTE, type Method } from "../method";
import { ROUTES } from "../routes";
import { HOST_TABLE } from "../../host-server/handlers";

/** The namespaces that read or write a host's projects, layout or agents. */
const ROUTED_NAMESPACES = ["projects", "layout", "agents", "github", "chat", "linear"];

const methods = SERVER_METHODS as unknown as Record<string, Method>;

function inNamespace(key: string, ns: string): boolean {
  return key.startsWith(`${ns}.`) && !key.slice(ns.length + 1).includes(".");
}

describe("routing surface (ADR-227 D4)", () => {
  it.each(ROUTED_NAMESPACES)("every %s method declares a route or LOCAL_ROUTE", (ns) => {
    const keys = Object.keys(methods).filter((key) => inNamespace(key, ns));
    expect(keys.length).toBeGreaterThan(0);
    const undeclared = keys.filter((key) => methods[key].rules.route === undefined);
    expect(undeclared).toEqual([]);
  });

  it("collects every rule but LOCAL_ROUTE into the desktop table", () => {
    for (const [key, entry] of Object.entries(methods)) {
      const route = entry.rules.route;
      if (route === undefined || route === LOCAL_ROUTE) {
        expect(DESKTOP_TABLE.routes.has(key)).toBe(false);
      } else {
        expect(DESKTOP_TABLE.routes.get(key)).toEqual(route);
      }
    }
  });

  it("routes only methods a host server answers", () => {
    const unanswered = [...DESKTOP_TABLE.routes.keys()].filter(
      (key) => !(key in HOST_TABLE.handlers),
    );
    expect(unanswered).toEqual([]);
  });

  it("reads each route's target off an argument the method takes", () => {
    for (const [key, rule] of DESKTOP_TABLE.routes) {
      // A delegated call names no argument (ADR-228 D10).
      if (rule.by === "delegated") continue;
      const fn = DESKTOP_TABLE.handlers[key] as (...args: unknown[]) => unknown;
      // `fn.length` counts the context and every parameter before the first
      // with a default.
      expect({ key, inRange: rule.arg < fn.length - 1 }).toEqual({ key, inRange: true });
    }
  });

  it("agrees with the route manifest (ADR-228 D1)", () => {
    // `merge` and `home` are both `LOCAL_ROUTE` on a table.
    const disagree = Object.entries(methods)
      .filter(([key, entry]) => entry.rules.route !== undefined && key in ROUTES)
      .filter(([key, entry]) => {
        const manifest = ROUTES[key];
        const route = entry.rules.route;
        return manifest === "merge" || manifest === "home"
          ? route !== LOCAL_ROUTE
          : JSON.stringify(route) !== JSON.stringify(manifest);
      })
      .map(([key]) => key);
    expect(disagree).toEqual([]);
  });

  it.each(ROUTED_NAMESPACES)("lists every %s method in the route manifest", (ns) => {
    const keys = Object.keys(methods).filter((key) => inNamespace(key, ns));
    expect(keys.filter((key) => !(key in ROUTES))).toEqual([]);
  });

  it("lists in the manifest only methods that declare a route", () => {
    const stray = Object.keys(ROUTES).filter((key) => methods[key]?.rules.route === undefined);
    expect(stray).toEqual([]);
  });

  it("routes a remote pane's terminal by pane, and keeps viewport reports home (ADR-228 D5, D7)", () => {
    for (const name of ["create", "attach", "reset", "write", "resize", "claimWinsize", "close", "detach"]) {
      expect({ name, route: DESKTOP_TABLE.routes.get(`pty.${name}`)?.by }).toEqual({ name, route: "pane" });
    }
    // A new pane's host is in its create's and reset's options.
    expect(DESKTOP_TABLE.routes.get("pty.create")).toEqual({ by: "pane", arg: 0, hostOpt: 4 });
    expect(DESKTOP_TABLE.routes.get("pty.reset")).toEqual({ by: "pane", arg: 0, hostOpt: 4 });
    // Only a desktop window has a prewarmed session.
    expect(DESKTOP_TABLE.routes.has("pty.consumePrewarmed")).toBe(false);
    expect(ROUTES["layout.reportViewport"]).toBe("home");
    expect(DESKTOP_TABLE.routes.has("layout.reportViewport")).toBe(false);
  });
});
