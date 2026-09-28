import { describe, it, expect } from "vitest";
import { hostIdForWorkspace, isLocalhostHttpUrl, remoteHostIdForWorkspace } from "../hosts";

describe("hostIdForWorkspace", () => {
  // The same path on this machine and on "box", as two projects.
  const shared = "/home/me/.manor/worktrees/app/feat";
  const projects = [
    { id: "p-local", path: "/home/me/app", hostId: "local", workspaces: [{ path: shared }] },
    { id: "p-box", path: "/home/me/app", hostId: "box", workspaces: [{ path: shared }] },
  ];

  it("names local hosts too", () => {
    expect(hostIdForWorkspace(projects, shared)).toBe("local");
  });

  it("prefers the given project when several have the path", () => {
    expect(hostIdForWorkspace(projects, shared, "p-box")).toBe("box");
    expect(hostIdForWorkspace(projects, shared, "p-local")).toBe("local");
    expect(remoteHostIdForWorkspace(projects, shared, "p-box")).toBe("box");
  });

  it("ignores a preferred project that doesn't have the path", () => {
    expect(hostIdForWorkspace(projects, shared, "p-other")).toBe("local");
  });

  it("is null for unknown paths and without a path", () => {
    expect(hostIdForWorkspace(projects, "/nowhere")).toBeNull();
    expect(hostIdForWorkspace(projects, null)).toBeNull();
  });
});

describe("remoteHostIdForWorkspace", () => {
  const projects = [
    { path: "/Users/me/app", hostId: "local", workspaces: [{ path: "/Users/me/app" }] },
    {
      path: "/home/me/api",
      hostId: "box",
      workspaces: [{ path: "/home/me/api" }, { path: "/home/me/.wt/api-feat" }],
    },
    { path: "/Users/me/old", hostId: "local", workspaces: [] },
  ];

  it("finds the remote host of a project root or worktree", () => {
    expect(remoteHostIdForWorkspace(projects, "/home/me/api")).toBe("box");
    expect(remoteHostIdForWorkspace(projects, "/home/me/.wt/api-feat")).toBe("box");
  });

  it("is null on this machine, for unknown paths and without a path", () => {
    expect(remoteHostIdForWorkspace(projects, "/Users/me/app")).toBeNull();
    expect(remoteHostIdForWorkspace(projects, "/Users/me/old")).toBeNull();
    expect(remoteHostIdForWorkspace(projects, "/nowhere")).toBeNull();
    expect(remoteHostIdForWorkspace(projects, undefined)).toBeNull();
  });
});

describe("isLocalhostHttpUrl", () => {
  it("matches http(s) loopback and portless URLs only", () => {
    expect(isLocalhostHttpUrl("http://localhost:3000")).toBe(true);
    expect(isLocalhostHttpUrl("https://127.0.0.1:8443/x")).toBe(true);
    expect(isLocalhostHttpUrl("http://[::1]:5173/")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost?x=1")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost.evil.com:3000")).toBe(false);
    expect(isLocalhostHttpUrl("http://feat.acme.localhost:1355/")).toBe(true);
    expect(isLocalhostHttpUrl("file:///tmp")).toBe(false);
  });
});
