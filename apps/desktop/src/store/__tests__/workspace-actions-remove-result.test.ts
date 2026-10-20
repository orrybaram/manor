import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeWorktreeWithToast } from "../workspace-actions";
import { useProjectStore } from "../project-store";
import { useToastStore } from "../toast-store";
import type { ProjectInfo, WorkspaceInfo } from "../project-store";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> })
  .electronAPI;
const originalProjects = electronAPI.projects;

const ws = { path: "/tmp/wt/locked", branch: "locked" } as WorkspaceInfo;
const project = {
  id: "p1",
  path: "/tmp/repo",
  name: "app",
  workspaces: [ws],
} as ProjectInfo;

// The sidebar dims a row while it is removed and only un-dims it once it
// leaves the list, so it has to hear about a removal that failed (git
// refuses a locked worktree) or the row stays dimmed until a restart.
describe("removeWorktreeWithToast", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [project] } as never);
    useToastStore.setState({ toasts: [] } as never);
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
  });

  function mainRemove(removeWorktree: () => Promise<void>) {
    electronAPI.projects = {
      removeWorktree: vi.fn(removeWorktree),
      onRemoveWorktreeProgress: vi.fn(() => () => {}),
      getAll: vi.fn().mockResolvedValue([{ ...project, workspaces: [] }]),
    };
  }

  it("resolves true once the worktree is removed", async () => {
    mainRemove(() => Promise.resolve());

    await expect(removeWorktreeWithToast(project, ws)).resolves.toBe(true);
  });

  it("resolves false, with git's reason in the toast, when removal fails", async () => {
    mainRemove(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'projects:removeWorktree': Error: Failed to remove worktree: cannot remove a locked working tree",
        ),
      ),
    );

    await expect(removeWorktreeWithToast(project, ws)).resolves.toBe(false);
    const [toast] = useToastStore.getState().toasts.slice(-1);
    expect(toast?.status).toBe("error");
    expect(toast?.detail).toBe(
      "Failed to remove worktree: cannot remove a locked working tree",
    );
  });
});
