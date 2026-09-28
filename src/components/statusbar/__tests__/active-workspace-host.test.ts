import { describe, it, expect } from "vitest";
import { activeWorkspaceHost } from "../StatusBar/active-workspace-host";

// A linked group (ADR-192): the same repo at the same paths on this machine
// and on "box".
const SHARED = "/home/me/.manor/worktrees/app/feat";
const localApp = { id: "p-local", path: "/home/me/app", hostId: "local", workspaces: [{ path: SHARED }] };
const boxApp = { id: "p-box", path: "/home/me/app", hostId: "box", workspaces: [{ path: SHARED }] };
const projects = [localApp, boxApp];

describe("activeWorkspaceHost", () => {
  it("follows the active workspace's own host, not the first project with the path", () => {
    expect(
      activeWorkspaceHost({ activeWorkspacePath: SHARED, activeWorkspaceHostId: "box" }, projects),
    ).toEqual({ hostId: "box", projectId: "p-box" });
    expect(
      activeWorkspaceHost({ activeWorkspacePath: SHARED, activeWorkspaceHostId: "local" }, projects),
    ).toEqual({ hostId: "local", projectId: "p-local" });
  });

  it("names the host even when no project there has the path", () => {
    expect(
      activeWorkspaceHost({ activeWorkspacePath: "/elsewhere", activeWorkspaceHostId: "box" }, projects),
    ).toEqual({ hostId: "box", projectId: undefined });
  });

  it("is empty without an active workspace", () => {
    expect(
      activeWorkspaceHost({ activeWorkspacePath: null, activeWorkspaceHostId: "box" }, projects),
    ).toEqual({ hostId: undefined, projectId: undefined });
  });
});
