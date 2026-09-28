import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import type { PrInfo } from "../../lib/pr-info";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> })
  .electronAPI;
const originalProjects = electronAPI.projects;

const pr = { number: 7, state: "open", title: "Keep me" } as PrInfo;

function workspaces() {
  return useProjectStore.getState().projects[0].workspaces;
}

// Main's project list never carries `pr`, so removing one workspace used to
// blank every other workspace's badge until the next poll refilled it.
describe("refreshing projects after removing a worktree", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          path: "/tmp/repo",
          name: "app",
          workspaces: [
            { path: "/tmp/wt/a", branch: "a", pr, diffStats: { added: 1, removed: 2 } },
            { path: "/tmp/wt/b", branch: "b", pr },
          ],
        },
      ],
    } as never);
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
  });

  function mainReturns(workspaceList: unknown[]) {
    electronAPI.projects = {
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([
        { id: "p1", path: "/tmp/repo", name: "app", workspaces: workspaceList },
      ]),
    };
  }

  it("keeps the PR and diff stats of the workspaces that remain", async () => {
    mainReturns([{ path: "/tmp/wt/a", branch: "a" }]);

    await useProjectStore.getState().removeWorktree("p1", "/tmp/wt/b");

    expect(workspaces()).toHaveLength(1);
    expect(workspaces()[0].pr).toBe(pr);
    expect(workspaces()[0].diffStats).toEqual({ added: 1, removed: 2 });
  });

  it("drops the PR of a workspace whose branch changed", async () => {
    mainReturns([{ path: "/tmp/wt/a", branch: "renamed" }]);

    await useProjectStore.getState().removeWorktree("p1", "/tmp/wt/b");

    expect(workspaces()[0].pr).toBeUndefined();
  });
});
