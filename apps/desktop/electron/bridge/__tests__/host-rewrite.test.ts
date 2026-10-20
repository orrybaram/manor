/**
 * The host rewrite: a host's `local` and bare paths against the
 * id and `<hostId>:<path>` keys of whoever holds several hosts.
 */

import { describe, expect, it } from "vitest";

import { keyFor, toDesktop, toDesktopResult, toHostArgs } from "../host-rewrite";

const HOST = "box";

describe("keyFor", () => {
  it("keys a bare path under the host", () => {
    expect(keyFor(HOST, "/a/b")).toBe("box:/a/b");
  });

  it("is null for a path that cannot be keyed", () => {
    expect(keyFor(HOST, "relative/path")).toBeNull();
  });
});

describe("toDesktop", () => {
  it("stamps the host's local as the host id", () => {
    expect(toDesktop(HOST, { id: "p", hostId: "local" })).toEqual({ id: "p", hostId: HOST });
  });

  it("leaves other values alone", () => {
    expect(toDesktop(HOST, { id: "p", hostId: "other" })).toEqual({ id: "p", hostId: "other" });
    expect(toDesktop(HOST, "x")).toBe("x");
    expect(toDesktop(HOST, null)).toBeNull();
  });
});

describe("toHostArgs", () => {
  it("turns this host's key into its bare path and its id into local", () => {
    expect(toHostArgs(HOST, ["box:/a/b", HOST, 3])).toEqual(["/a/b", "local", 3]);
  });

  it("rewrites one level into a plain object", () => {
    expect(toHostArgs(HOST, [{ workspacePath: "box:/a", hostId: HOST, n: 1 }])).toEqual([
      { workspacePath: "/a", hostId: "local", n: 1 },
    ]);
  });

  it("leaves another host's key and a bare local path alone", () => {
    expect(toHostArgs(HOST, ["other:/a", "/local/path"])).toEqual(["other:/a", "/local/path"]);
  });
});

describe("toDesktopResult", () => {
  it("rekeys layout.getAll and drops what cannot be keyed", () => {
    expect(
      toDesktopResult(HOST, "layout", "getAll", { "/a": 1, "/b": 2, "rel": 3 }),
    ).toEqual({ "box:/a": 1, "box:/b": 2 });
  });

  it("keys layout.getLastActive", () => {
    expect(toDesktopResult(HOST, "layout", "getLastActive", "/a")).toBe("box:/a");
    expect(toDesktopResult(HOST, "layout", "getLastActive", null)).toBeNull();
  });

  it("stamps a record, or each record of a list", () => {
    expect(toDesktopResult(HOST, "projects", "getAll", [{ hostId: "local" }, { hostId: "x" }])).toEqual([
      { hostId: HOST },
      { hostId: "x" },
    ]);
    expect(toDesktopResult(HOST, "agents", "get", { hostId: "local" })).toEqual({ hostId: HOST });
  });
});
