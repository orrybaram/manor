/**
 * The shared workspace-key helpers (ADR-191) from the main process's side:
 * they compile under `tsconfig.electron.json` and take main's own
 * `ProjectInfo` as a migration owner without mapping.
 */
import { describe, it, expect } from "vitest";
import {
  LOCAL_HOST_ID as SHARED_LOCAL_HOST_ID,
  migrateWorkspaceKey,
  parseWorkspaceKey,
  workspaceKey,
} from "../../src/lib/workspace-key";
import { LOCAL_HOST_ID } from "../backend/types";
import type { ProjectInfo } from "./types";

function project(id: string, hostId: string, path: string, workspaces: string[]): ProjectInfo {
  return {
    id,
    name: id,
    path,
    defaultBranch: "main",
    workspaces: workspaces.map((p, i) => ({
      path: p,
      branch: `b${i}`,
      isMain: p === path,
      name: null,
    })),
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    hostId,
    folders: [],
    sidebarOrder: [],
  };
}

describe("workspace keys in the main process", () => {
  it("uses the same local host id as the backend", () => {
    expect(SHARED_LOCAL_HOST_ID).toBe(LOCAL_HOST_ID);
    expect(parseWorkspaceKey("/x").hostId).toBe(LOCAL_HOST_ID);
    expect(workspaceKey(LOCAL_HOST_ID, "/x")).toBe("/x");
  });

  it("migrates by main's ProjectInfo, keeping two hosts' identical paths apart", () => {
    const projects = [
      project("laptop", LOCAL_HOST_ID, "/home/me/app", ["/home/me/app", "/home/me/wt/feat"]),
      project("box", "box", "/home/me/app", ["/home/me/app", "/home/me/wt/fix"]),
    ];
    expect(migrateWorkspaceKey("/home/me/wt/fix", projects)).toBe("box:/home/me/wt/fix");
    expect(migrateWorkspaceKey("/home/me/wt/feat", projects)).toBe("/home/me/wt/feat");
    // The shared root is ambiguous in legacy data; local wins, as in PathRouter.
    expect(migrateWorkspaceKey("/home/me/app", projects)).toBe("/home/me/app");
    // Once qualified, the two checkouts of the same path are distinct keys.
    expect(workspaceKey("box", "/home/me/app")).not.toBe(
      workspaceKey(LOCAL_HOST_ID, "/home/me/app"),
    );
  });
});
