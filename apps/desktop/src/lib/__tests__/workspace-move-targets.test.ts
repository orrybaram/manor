import { describe, it, expect } from "vitest";
import {
  canMoveToWorkspace,
  matchesMoveQuery,
  workspaceMoveTargets,
} from "../workspace-move-targets";
import { workspaceKey } from "../workspace-key";
import { HOME_PATH } from "../home-path";

const MAIN = "/home/me/app";
const FEAT = "/home/me/.manor/worktrees/app/feat";
const FIX = "/home/me/.manor/worktrees/app/fix";
const OLD = "/home/me/.manor/worktrees/app/old";
const LIB = "/home/me/lib";

interface Ws {
  path: string;
  hidden?: boolean;
}

function project(id: string, hostId: string, workspaces: Ws[], sidebarOrder?: string[]) {
  return { id, path: workspaces[0].path, hostId, workspaces, sidebarOrder };
}

// The app on this machine and on "box" (a linked group's two sections, at
// the same paths), and another project on this machine.
function projects() {
  return [
    project("app-local", "local", [
      { path: MAIN },
      { path: FEAT },
      { path: FIX },
      { path: OLD, hidden: true },
    ]),
    project("app-box", "box", [{ path: MAIN }, { path: FEAT }]),
    project("lib", "local", [{ path: LIB }]),
  ];
}

const keys = (source: string) =>
  workspaceMoveTargets(projects(), source as never).map((t) => t.key);

describe("workspaceMoveTargets", () => {
  it("offers the project's other workspaces on the source's host", () => {
    expect(keys(FEAT)).toEqual([MAIN, FIX]);
  });

  it("leaves out the source, hidden workspaces, other projects and other hosts", () => {
    const found = keys(FEAT);
    expect(found).not.toContain(FEAT);
    expect(found).not.toContain(OLD);
    expect(found).not.toContain(LIB);
    expect(found).not.toContain(workspaceKey("box", MAIN));
  });

  it("keys a remote project's targets on its host", () => {
    expect(keys(workspaceKey("box", FEAT))).toEqual([workspaceKey("box", MAIN)]);
  });

  it("is empty for Home, an unknown workspace, or a project with one workspace", () => {
    expect(keys(HOME_PATH)).toEqual([]);
    expect(keys("/nowhere")).toEqual([]);
    expect(keys(LIB)).toEqual([]);
  });

  it("follows the sidebar's order", () => {
    const ordered = [project("app", "local", [{ path: MAIN }, { path: FEAT }, { path: FIX }], [FIX, "folder-1", MAIN])];
    expect(workspaceMoveTargets(ordered, FEAT as never).map((t) => t.workspace.path)).toEqual([FIX, MAIN]);
  });
});

describe("canMoveToWorkspace", () => {
  it("allows a sibling and refuses everything else", () => {
    const list = projects();
    const from = FEAT as never;
    expect(canMoveToWorkspace(list, from, MAIN as never)).toBe(true);
    expect(canMoveToWorkspace(list, from, FEAT as never)).toBe(false);
    expect(canMoveToWorkspace(list, from, LIB as never)).toBe(false);
    expect(canMoveToWorkspace(list, from, workspaceKey("box", MAIN))).toBe(false);
    expect(canMoveToWorkspace(list, from, HOME_PATH as never)).toBe(false);
  });
});

describe("matchesMoveQuery", () => {
  it("matches every word in the label or the branch, ignoring case", () => {
    expect(matchesMoveQuery("Login page", "feat/login", "")).toBe(true);
    expect(matchesMoveQuery("Login page", "feat/login", "LOG")).toBe(true);
    expect(matchesMoveQuery("Login page", "feat/login", "feat page")).toBe(true);
    expect(matchesMoveQuery("Login page", "feat/login", "fix")).toBe(false);
    expect(matchesMoveQuery("main", null, "main")).toBe(true);
  });
});
