/**
 * The host rewrite: a host's `local` and bare paths against the
 * id and `<hostId>:<path>` keys of whoever holds several hosts.
 */

import { describe, expect, it } from "vitest";

import { hostRecord, keyFor, toDesktop, toDesktopResult, toHostArgs } from "../host-rewrite";

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

  it("stamps over a host id naming any other host", () => {
    expect(toDesktop(HOST, { id: "p", hostId: "other" })).toEqual({ id: "p", hostId: HOST });
    expect(toDesktop(HOST, { id: "p", hostId: "" })).toEqual({ id: "p", hostId: HOST });
  });

  it("leaves other values alone", () => {
    expect(toDesktop(HOST, { id: "p" })).toEqual({ id: "p" });
    expect(toDesktop(HOST, "x")).toBe("x");
    expect(toDesktop(HOST, null)).toBeNull();
  });
});

describe("hostRecord", () => {
  it("stamps the host's id on a record that left it out", () => {
    expect(hostRecord(HOST, { id: "p", path: "/Users/me/work" })).toEqual({
      id: "p",
      path: "/Users/me/work",
      hostId: HOST,
    });
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

  it("rewrites an automation's nested workspace", () => {
    expect(
      toHostArgs(HOST, [
        HOST,
        { name: "n", workspace: { mode: "reuse", workspacePath: "box:/a" } },
      ]),
    ).toEqual(["local", { name: "n", workspace: { mode: "reuse", workspacePath: "/a" } }]);
    expect(toHostArgs(HOST, [HOST, "a1", { workspace: { workspacePath: "other:/a" } }])).toEqual([
      "local",
      "a1",
      { workspace: { workspacePath: "other:/a" } },
    ]);
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

  it("keys where layout.moveToWorkspace landed, and leaves a refusal alone", () => {
    expect(
      toDesktopResult(HOST, "layout", "moveToWorkspace", { workspacePath: "/b", tabId: "t" }),
    ).toEqual({ workspacePath: "box:/b", tabId: "t" });
    expect(toDesktopResult(HOST, "layout", "moveToWorkspace", { error: "no" })).toEqual({
      error: "no",
    });
  });

  it("keys an automation's workspace paths: its reused workspace, its last run's and each run's", () => {
    const view = {
      hostId: "local",
      workspace: { mode: "reuse", workspacePath: "/a" },
      lastRun: { id: "r2", workspacePath: "/a" },
    };
    expect(toDesktopResult(HOST, "automations", "list", [view, { hostId: "local", workspace: { mode: "new" }, lastRun: null }])).toEqual([
      { hostId: HOST, workspace: { mode: "reuse", workspacePath: "box:/a" }, lastRun: { id: "r2", workspacePath: "box:/a" } },
      { hostId: HOST, workspace: { mode: "new" }, lastRun: null },
    ]);
    expect(
      toDesktopResult(HOST, "automations", "get", {
        ...view,
        runs: [{ id: "r2", workspacePath: "/a" }, { id: "r1", outcome: "skipped" }],
      }),
    ).toEqual({
      hostId: HOST,
      workspace: { mode: "reuse", workspacePath: "box:/a" },
      lastRun: { id: "r2", workspacePath: "box:/a" },
      runs: [{ id: "r2", workspacePath: "box:/a" }, { id: "r1", outcome: "skipped" }],
    });
    expect(toDesktopResult(HOST, "automations", "runNow", { id: "r3", workspacePath: "/b" })).toEqual({
      id: "r3",
      workspacePath: "box:/b",
    });
    expect(toDesktopResult(HOST, "automations", "get", null)).toBeNull();
  });

  it("stamps a record, or each record of a list", () => {
    expect(toDesktopResult(HOST, "projects", "getAll", [{ hostId: "local" }, { hostId: "x" }])).toEqual([
      { hostId: HOST },
      { hostId: HOST },
    ]);
    expect(toDesktopResult(HOST, "agents", "get", { hostId: "local" })).toEqual({ hostId: HOST });
  });

  it("stamps a project the host answered with no host id", () => {
    const project = { id: "p", workspaces: [], worktreeStartScript: "x" };
    expect(toDesktopResult(HOST, "projects", "createWorktree", project)).toEqual({
      ...project,
      hostId: HOST,
    });
  });

  it("leaves a non-record answer without a host id alone", () => {
    expect(toDesktopResult(HOST, "git", "status", { branch: "main" })).toEqual({ branch: "main" });
  });
});
