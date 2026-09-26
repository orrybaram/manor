import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> })
  .electronAPI;
const originalProjects = electronAPI.projects;

function project() {
  return useProjectStore.getState().projects[0];
}

describe("updateProject rollback", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        { id: "p1", path: "/tmp/repo", name: "app", hostId: "local", workspaces: [] },
      ],
    } as never);
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
  });

  it("restores the previous value when main refuses the update", async () => {
    electronAPI.projects = {
      update: vi.fn().mockRejectedValue(new Error("write failed")),
    };

    const pending = useProjectStore.getState().updateProject("p1", { name: "renamed" });
    // Optimistic: the UI moves immediately.
    expect(project().name).toBe("renamed");
    await expect(pending).rejects.toThrow("write failed");
    expect(project().name).toBe("app");
  });

  it("does not clobber a newer update that landed meanwhile", async () => {
    let reject!: (err: Error) => void;
    electronAPI.projects = {
      update: vi
        .fn()
        .mockImplementationOnce(
          () => new Promise((_resolve, r) => (reject = r)),
        )
        .mockResolvedValueOnce(null),
    };

    const first = useProjectStore.getState().updateProject("p1", { name: "first" });
    await useProjectStore.getState().updateProject("p1", { name: "second" });
    reject(new Error("nope"));
    await expect(first).rejects.toThrow("nope");
    expect(project().name).toBe("second");
  });
});
