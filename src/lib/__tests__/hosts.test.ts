import { describe, it, expect } from "vitest";
import {
  hostIdForWorkspace,
  isLocalhostHttpUrl,
  projectForWorkspace,
  workspaceHostId,
} from "../hosts";
import { HOME_PATH } from "../home-path";

// The same repo at the same paths on this machine and on "box", as two
// projects (same username, same default roots).
const SHARED = "/home/me/.manor/worktrees/app/feat";
const MAIN = "/home/me/app";
const localApp = { id: "p-local", path: MAIN, hostId: "local", workspaces: [{ path: SHARED }] };
const boxApp = { id: "p-box", path: MAIN, hostId: "box", workspaces: [{ path: SHARED }] };
const sharedProjects = [localApp, boxApp];

describe("projectForWorkspace", () => {
  it("finds the project by a workspace or its main checkout", () => {
    expect(projectForWorkspace(sharedProjects, SHARED)).toBe(localApp);
    expect(projectForWorkspace(sharedProjects, MAIN)).toBe(localApp);
  });

  it("prefers the given project when two hosts have the path", () => {
    expect(projectForWorkspace(sharedProjects, SHARED, "p-box")).toBe(boxApp);
    expect(projectForWorkspace(sharedProjects, MAIN, "p-box")).toBe(boxApp);
  });

  it("ignores a preferred project that doesn't have the path", () => {
    const other = { id: "p-other", path: "/x", hostId: "box", workspaces: [] };
    expect(projectForWorkspace([...sharedProjects, other], SHARED, "p-other")).toBe(localApp);
  });

  it("is undefined for unknown paths and without a path", () => {
    expect(projectForWorkspace(sharedProjects, "/nowhere")).toBeUndefined();
    expect(projectForWorkspace(sharedProjects, null)).toBeUndefined();
  });
});

describe("hostIdForWorkspace", () => {
  it("names the host of the path's project, local too", () => {
    expect(hostIdForWorkspace(sharedProjects, SHARED)).toBe("local");
    expect(hostIdForWorkspace(sharedProjects, SHARED, "p-box")).toBe("box");
  });

  it("is undefined when no project has the path", () => {
    expect(hostIdForWorkspace(sharedProjects, "/nowhere")).toBeUndefined();
  });
});

describe("workspaceHostId", () => {
  it("follows the selected project when two hosts have the path", () => {
    expect(workspaceHostId({ projects: sharedProjects, selectedProjectIndex: 1 }, SHARED)).toBe("box");
    expect(workspaceHostId({ projects: sharedProjects, selectedProjectIndex: 0 }, SHARED)).toBe(
      "local",
    );
  });

  it("puts Home on this machine", () => {
    expect(workspaceHostId({ projects: sharedProjects, selectedProjectIndex: 1 }, HOME_PATH)).toBe(
      "local",
    );
  });

  it("is undefined for a path no project has, so main guesses from it", () => {
    expect(workspaceHostId({ projects: sharedProjects, selectedProjectIndex: 1 }, "/tmp")).toBeUndefined();
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
