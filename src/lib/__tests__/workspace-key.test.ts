import { describe, it, expect } from "vitest";
import {
  isRemoteWorkspaceKey,
  migrateWorkspaceKey,
  migrateWorkspaceKeyedRecord,
  ownerHostIdForPath,
  parseWorkspaceKey,
  workspaceKey,
  type WorkspaceKeyOwner,
} from "../workspace-key";
import { LOCAL_HOST_ID } from "../hosts";

const BOX = "3f1c2a9e-8d7b-4c6a-9e0f-1a2b3c4d5e6f";

describe("workspaceKey", () => {
  it("keys a local workspace by its bare path", () => {
    expect(workspaceKey(LOCAL_HOST_ID, "/home/me/app")).toBe("/home/me/app");
    expect(workspaceKey(undefined, "/home/me/app")).toBe("/home/me/app");
    expect(workspaceKey(null, "/home/me/app")).toBe("/home/me/app");
  });

  it("qualifies a remote workspace with its host id", () => {
    expect(workspaceKey(BOX, "/home/me/app")).toBe(`${BOX}:/home/me/app`);
  });

  it("is deterministic and tells the same path on two hosts apart", () => {
    expect(workspaceKey(BOX, "/p")).toBe(workspaceKey(BOX, "/p"));
    expect(workspaceKey(BOX, "/p")).not.toBe(workspaceKey(LOCAL_HOST_ID, "/p"));
    expect(workspaceKey(BOX, "/p")).not.toBe(workspaceKey("other", "/p"));
  });

  it("rejects a host id that could not be parsed back", () => {
    expect(() => workspaceKey("a:b", "/p")).toThrow(/Invalid host id/);
    expect(() => workspaceKey("a/b", "/p")).toThrow(/Invalid host id/);
  });
});

describe("parseWorkspaceKey", () => {
  it("round-trips local and remote keys", () => {
    for (const [hostId, path] of [
      [LOCAL_HOST_ID, "/home/me/app"],
      [BOX, "/home/me/app"],
      [BOX, "/home/me/with:colon/app"],
      ["box", "/"],
    ] as const) {
      expect(parseWorkspaceKey(workspaceKey(hostId, path))).toEqual({ hostId, path });
    }
  });

  it("reads a bare or non-absolute key as a local path", () => {
    expect(parseWorkspaceKey("/a/b")).toEqual({ hostId: LOCAL_HOST_ID, path: "/a/b" });
    expect(parseWorkspaceKey("/a:b/c")).toEqual({ hostId: LOCAL_HOST_ID, path: "/a:b/c" });
    expect(parseWorkspaceKey("C:\\code\\app")).toEqual({
      hostId: LOCAL_HOST_ID,
      path: "C:\\code\\app",
    });
    expect(parseWorkspaceKey("~/x:y")).toEqual({ hostId: LOCAL_HOST_ID, path: "~/x:y" });
  });

  it("says whether a key is remote", () => {
    expect(isRemoteWorkspaceKey(workspaceKey(BOX, "/a"))).toBe(true);
    expect(isRemoteWorkspaceKey("/a")).toBe(false);
  });
});

describe("migration of path-only keys", () => {
  // The collision the ADR fixes: the same repo checked out at the same path
  // on the laptop and on the box.
  const local: WorkspaceKeyOwner = {
    hostId: LOCAL_HOST_ID,
    path: "/home/me/code/app",
    workspaces: [{ path: "/home/me/code/app" }, { path: "/home/me/.manor/worktrees/app/feat" }],
  };
  const remote: WorkspaceKeyOwner = {
    hostId: BOX,
    path: "/home/me/code/app",
    workspaces: [{ path: "/home/me/code/app" }, { path: "/home/me/.manor/worktrees/app/fix" }],
    worktreeRoot: "/home/me/.manor/worktrees/app",
  };
  const onlyRemote: WorkspaceKeyOwner = { hostId: BOX, path: "/srv/api" };

  it("assigns a path to the host of the project that owns it", () => {
    const owners = [local, remote, onlyRemote];
    expect(migrateWorkspaceKey("/srv/api", owners)).toBe(workspaceKey(BOX, "/srv/api"));
    expect(migrateWorkspaceKey("/home/me/.manor/worktrees/app/fix", owners)).toBe(
      workspaceKey(BOX, "/home/me/.manor/worktrees/app/fix"),
    );
    expect(migrateWorkspaceKey("/home/me/.manor/worktrees/app/feat", owners)).toBe(
      "/home/me/.manor/worktrees/app/feat",
    );
  });

  it("uses the worktree root for a workspace the project no longer lists", () => {
    expect(ownerHostIdForPath([local, remote], "/home/me/.manor/worktrees/app/gone")).toBe(BOX);
  });

  it("picks the closest root, and local on an equal match", () => {
    expect(ownerHostIdForPath([local, remote], "/home/me/code/app")).toBe(LOCAL_HOST_ID);
    expect(ownerHostIdForPath([remote, local], "/home/me/code/app")).toBe(LOCAL_HOST_ID);
    expect(ownerHostIdForPath([remote], "/home/me/code/app")).toBe(BOX);
    expect(ownerHostIdForPath([remote], "/home/me/code/application")).toBe(LOCAL_HOST_ID);
  });

  it("falls back to local when no project owns the path", () => {
    expect(migrateWorkspaceKey("/nowhere", [local, remote])).toBe("/nowhere");
    expect(migrateWorkspaceKey("/nowhere", [])).toBe("/nowhere");
  });

  it("reads a project without a host id as local", () => {
    expect(ownerHostIdForPath([{ path: "/p" }, { hostId: BOX, path: "/p" }], "/p")).toBe(
      LOCAL_HOST_ID,
    );
  });

  it("leaves an already-qualified key alone", () => {
    const key = workspaceKey("other", "/srv/api");
    expect(migrateWorkspaceKey(key, [onlyRemote])).toBe(key);
  });

  it("rekeys a record without losing entries, keeping local keys as they were", () => {
    const qualified = workspaceKey(BOX, "/home/me/.manor/worktrees/app/fix");
    const migrated = migrateWorkspaceKeyedRecord(
      {
        "/home/me/code/app": "laptop main",
        "/home/me/.manor/worktrees/app/fix": "box fix",
        "/srv/api": "box api",
        "/nowhere": "stray",
      },
      [local, remote, onlyRemote],
    );
    expect(migrated).toEqual({
      "/home/me/code/app": "laptop main",
      [qualified]: "box fix",
      [workspaceKey(BOX, "/srv/api")]: "box api",
      "/nowhere": "stray",
    });
  });

  it("prefers an already-qualified entry over a legacy one for the same workspace", () => {
    const key = workspaceKey(BOX, "/srv/api");
    const legacyFirst = { "/srv/api": "old", [key]: "new" };
    const qualifiedFirst = { [key]: "new", "/srv/api": "old" };
    expect(migrateWorkspaceKeyedRecord(legacyFirst, [onlyRemote])).toEqual({ [key]: "new" });
    expect(migrateWorkspaceKeyedRecord(qualifiedFirst, [onlyRemote])).toEqual({ [key]: "new" });
  });

  it("changes nothing for a local-only user", () => {
    const record = { "/a": 1, "/b/c": 2 };
    expect(migrateWorkspaceKeyedRecord(record, [{ hostId: LOCAL_HOST_ID, path: "/a" }])).toEqual(
      record,
    );
  });
});
