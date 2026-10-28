/**
 * `projectWorkspaceCheck` — a move stays inside one project's workspaces.
 */

import { describe, it, expect } from "vitest";
import { projectWorkspaceCheck } from "../workspace-move-check";
import type { ProjectInfo } from "../../projects/types";
import type { WorkspaceKey } from "../../../src/lib/workspace-key";

function project(id: string, hostId: string, paths: string[]): ProjectInfo {
  return {
    id,
    name: id,
    hostId,
    workspaces: paths.map((path) => ({ path, branch: "b", isMain: false, name: null })),
  } as unknown as ProjectInfo;
}

const check = projectWorkspaceCheck({
  getProjects: async () => [
    project("app", "local", ["/app", "/app-wt/feature"]),
    project("lib", "local", ["/lib"]),
    project("remote-app", "box", ["/app", "/app-wt/other"]),
  ],
});

const key = (k: string) => k as WorkspaceKey;

describe("projectWorkspaceCheck", () => {
  it("allows two workspaces of one project", async () => {
    expect(await check(key("/app"), key("/app-wt/feature"))).toBeNull();
    expect(await check(key("box:/app"), key("box:/app-wt/other"))).toBeNull();
  });

  it("refuses another project", async () => {
    expect(await check(key("/app"), key("/lib"))).toMatch(/another project/);
  });

  it("refuses a path no project lists as a workspace", async () => {
    expect(await check(key("/app"), key("/app/src"))).toBe("Unknown workspace: /app/src");
    // The same path on a host that lacks it is not a workspace there.
    expect(await check(key("box:/app"), key("box:/app-wt/feature"))).toBe(
      "Unknown workspace: /app-wt/feature",
    );
  });
});
