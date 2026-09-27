import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> })
  .electronAPI;
const originalProjects = electronAPI.projects;

describe("addRemoteProject (ADR-178 ticket 5)", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectIndex: 0 } as never);
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
  });

  it("appends the returned project and selects it", async () => {
    const newProject = {
      id: "p1",
      name: "Repo",
      path: "/home/user/repo",
      hostId: "box",
      workspaces: [{ path: "/home/user/repo", branch: "main", isMain: true, name: null }],
    };
    const addRemote = vi.fn().mockResolvedValue(newProject);
    electronAPI.projects = { addRemote };

    const result = await useProjectStore.getState().addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "~/repo",
      name: "Repo",
    });

    expect(addRemote).toHaveBeenCalledWith({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "~/repo",
      name: "Repo",
    });
    expect(result).toEqual(newProject);
    expect(useProjectStore.getState().projects).toEqual([newProject]);
    expect(useProjectStore.getState().selectedProjectIndex).toBe(0);
  });

  it("propagates a failure (e.g. clone or validation error) without adding a project", async () => {
    electronAPI.projects = {
      addRemote: vi.fn().mockRejectedValue(new Error("git clone exited with code 128")),
    };

    await expect(
      useProjectStore.getState().addRemoteProject({
        hostId: "box",
        repoUrl: "https://github.com/org/repo.git",
        remoteDir: "/srv/app",
        name: "App",
      }),
    ).rejects.toThrow("git clone exited with code 128");
    expect(useProjectStore.getState().projects).toEqual([]);
  });
});
