/**
 * Linear's auto-match: the match is a read any server holding
 * the token may answer, and the write is the project's own.
 */

import { describe, expect, it, vi } from "vitest";

import { linearAssociateProject, linearAutoMatch } from "../integrations";
import { localCtx } from "../../method";
import type { SharedDeps } from "../../../ipc/types";

const TEAM = { id: "t1", name: "App", key: "APP" };
const ASSOCIATION = { teamId: "t1", teamName: "App", teamKey: "APP" };

function deps(projects: Array<{ id: string; name: string; linearAssociations: unknown[] }>) {
  const projectManager = {
    getProjects: vi.fn(async () => projects),
    updateProject: vi.fn(async () => null),
  };
  const linearManager = {
    getTeams: vi.fn(async () => [TEAM]),
    autoMatchProjects: vi.fn((ps: Array<{ id: string; name: string }>) =>
      Object.fromEntries(ps.filter((p) => p.name === "App").map((p) => [p.id, ASSOCIATION])),
    ),
  };
  return {
    projectManager,
    linearManager,
    ctx: localCtx({ projectManager, linearManager } as unknown as SharedDeps),
  };
}

describe("linear.autoMatch", () => {
  it("matches the projects it is given and writes none", async () => {
    const d = deps([]);
    const matches = await linearAutoMatch(d.ctx, [
      { id: "p1", name: "App" },
      { id: "p2", name: "Other" },
    ]);
    expect(matches).toEqual({ p1: ASSOCIATION });
    expect(d.projectManager.updateProject).not.toHaveBeenCalled();
  });

  it("matches this server's own unmatched projects when given none", async () => {
    const d = deps([
      { id: "p1", name: "App", linearAssociations: [] },
      { id: "p2", name: "App", linearAssociations: [ASSOCIATION] },
    ]);
    expect(await linearAutoMatch(d.ctx)).toEqual({ p1: ASSOCIATION });
    expect(d.projectManager.updateProject).not.toHaveBeenCalled();
  });

  it("refuses a malformed list", async () => {
    await expect(linearAutoMatch(deps([]).ctx, [{ id: 1 }] as never)).rejects.toThrow();
  });
});

describe("linear.associateProject", () => {
  it("gives a project with no team its match, and leaves one that has a team", async () => {
    const d = deps([
      { id: "p1", name: "App", linearAssociations: [] },
      { id: "p2", name: "App", linearAssociations: [ASSOCIATION] },
    ]);
    expect(await linearAssociateProject(d.ctx, "p1", ASSOCIATION)).toBe(true);
    expect(d.projectManager.updateProject).toHaveBeenCalledExactlyOnceWith("p1", {
      linearAssociations: [ASSOCIATION],
    });
    expect(await linearAssociateProject(d.ctx, "p2", ASSOCIATION)).toBe(false);
    expect(await linearAssociateProject(d.ctx, "gone", ASSOCIATION)).toBe(false);
    expect(d.projectManager.updateProject).toHaveBeenCalledOnce();
  });
});
