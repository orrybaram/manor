import { describe, it, expect, vi } from "vitest";
import { matchPath, dispatch } from "./router";
import type { ControlDeps, Route, RouteContext } from "./types";

const deps = {} as ControlDeps;
const noBody = () => Promise.resolve({});

/** Collects the single `json(status, body)` a dispatch is allowed to write. */
function recorder() {
  const calls: Array<{ status: number; body: unknown }> = [];
  const json = (status: number, body: unknown) => calls.push({ status, body });
  return { calls, json };
}

function route(
  method: Route["method"],
  path: string,
  handler: Route["handler"] = async () => {},
): Route {
  return { method, path, handler };
}

describe("matchPath", () => {
  it("matches a static path exactly", () => {
    expect(matchPath("/panes", ["panes"])).toEqual({});
  });

  it("rejects a segment-count mismatch rather than prefix-matching", () => {
    expect(matchPath("/panes", ["panes", "split"])).toBeNull();
    expect(matchPath("/panes/split", ["panes"])).toBeNull();
  });

  it("rejects a differing static segment", () => {
    expect(matchPath("/panes/split", ["panes", "merge"])).toBeNull();
  });

  it("captures :params", () => {
    expect(
      matchPath("/projects/:projectId/issues/:issueRef", [
        "projects",
        "p1",
        "issues",
        "42",
      ]),
    ).toEqual({ projectId: "p1", issueRef: "42" });
  });

  it("decodes captured params exactly once", () => {
    expect(matchPath("/panes/:paneId", ["pane%2Fa%20b"])).toBeNull();
    expect(matchPath("/panes/:paneId", ["panes", "pane%2Fa%20b"])).toEqual({
      paneId: "pane/a b",
    });
  });

  it("does not decode static segments", () => {
    // "%70anes" would decode to "panes"; a static segment compares raw.
    expect(matchPath("/panes", ["%70anes"])).toBeNull();
  });

  it("matches the empty path", () => {
    expect(matchPath("/", [])).toEqual({});
  });
});

describe("dispatch", () => {
  it("runs the first route whose path and method both match", async () => {
    const hit = vi.fn(async () => {});
    const miss = vi.fn(async () => {});
    const { json } = recorder();

    const matched = await dispatch(
      [route("GET", "/panes", miss), route("POST", "/panes", hit)],
      ["panes"],
      deps,
      "POST",
      new URL("http://x/panes"),
      json,
      noBody,
    );

    expect(matched).toBe(true);
    expect(hit).toHaveBeenCalledOnce();
    expect(miss).not.toHaveBeenCalled();
  });

  it("hands the handler decoded params, the url, json and readBody", async () => {
    const { json } = recorder();
    let seen: RouteContext | undefined;

    await dispatch(
      [
        route("GET", "/projects/:projectId", async (ctx) => {
          seen = ctx;
        }),
      ],
      ["projects"],
      deps,
      "GET",
      new URL("http://x/projects/a%20b?source=linear"),
      json,
      noBody,
    );

    expect(seen?.params).toEqual({ projectId: "a b" });
    expect(seen?.url.searchParams.get("source")).toBe("linear");
    expect(seen?.deps).toBe(deps);
    expect(seen?.json).toBe(json);
    expect(seen?.readBody).toBe(noBody);
  });

  it("prefers a static segment over a :param that would also capture it", async () => {
    const split = vi.fn(async () => {});
    const byId = vi.fn(async () => {});
    const { json } = recorder();

    await dispatch(
      [
        route("POST", "/panes/split", split),
        route("POST", "/panes/:paneId", byId),
      ],
      ["panes"],
      deps,
      "POST",
      new URL("http://x/panes/split"),
      json,
      noBody,
    );

    expect(split).toHaveBeenCalledOnce();
    expect(byId).not.toHaveBeenCalled();
  });

  it("falls past a method-mismatched static route onto a later :param route", async () => {
    // DELETE /panes/split closes the pane literally named "split": the POST-only
    // static row must not swallow the request.
    const split = vi.fn(async () => {});
    const byId = vi.fn(async () => {});
    const { json } = recorder();

    const matched = await dispatch(
      [
        route("POST", "/panes/split", split),
        route("DELETE", "/panes/:paneId", byId),
      ],
      ["panes"],
      deps,
      "DELETE",
      new URL("http://x/panes/split"),
      json,
      noBody,
    );

    expect(matched).toBe(true);
    expect(split).not.toHaveBeenCalled();
    expect(byId).toHaveBeenCalledOnce();
  });

  it("405s once when the path matches but no route takes the method", async () => {
    const { calls, json } = recorder();

    const matched = await dispatch(
      [route("GET", "/panes"), route("DELETE", "/panes")],
      ["panes"],
      deps,
      "POST",
      new URL("http://x/panes"),
      json,
      noBody,
    );

    expect(matched).toBe(true);
    expect(calls).toEqual([
      { status: 405, body: { error: "Method not allowed" } },
    ]);
  });

  it("404s an unknown sub-path under an owned prefix", async () => {
    const { calls, json } = recorder();

    const matched = await dispatch(
      [route("GET", "/panes")],
      ["panes"],
      deps,
      "GET",
      new URL("http://x/panes/a/b/c"),
      json,
      noBody,
    );

    expect(matched).toBe(true);
    expect(calls).toEqual([{ status: 404, body: { error: "Not found" } }]);
  });

  it("returns false and writes nothing when no path matches an owned prefix", async () => {
    const { calls, json } = recorder();

    const matched = await dispatch(
      [route("GET", "/panes")],
      ["panes"],
      deps,
      "GET",
      new URL("http://x/webview/pane-1/screenshot"),
      json,
      noBody,
    );

    expect(matched).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns false for the root path", async () => {
    const { calls, json } = recorder();

    const matched = await dispatch(
      [route("GET", "/panes")],
      ["panes"],
      deps,
      "GET",
      new URL("http://x/"),
      json,
      noBody,
    );

    expect(matched).toBe(false);
    expect(calls).toEqual([]);
  });

  it("awaits an async handler before reporting the match", async () => {
    let done = false;
    const { json } = recorder();

    const matched = await dispatch(
      [
        route("GET", "/panes", async () => {
          await new Promise((r) => setTimeout(r, 1));
          done = true;
        }),
      ],
      ["panes"],
      deps,
      "GET",
      new URL("http://x/panes"),
      json,
      noBody,
    );

    expect(matched).toBe(true);
    expect(done).toBe(true);
  });
});
