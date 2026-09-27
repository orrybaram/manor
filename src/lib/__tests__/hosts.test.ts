import { describe, it, expect } from "vitest";
import { isLocalhostHttpUrl, remoteHostIdForWorkspace } from "../hosts";

describe("remoteHostIdForWorkspace", () => {
  const projects = [
    { path: "/Users/me/app", workspaces: [{ path: "/Users/me/app" }] },
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
