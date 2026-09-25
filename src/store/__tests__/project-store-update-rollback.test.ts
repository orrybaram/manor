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

  it("restores the previous host when main refuses the update", async () => {
    electronAPI.projects = {
      update: vi.fn().mockRejectedValue(new Error("Unknown host")),
    };

    const pending = useProjectStore.getState().updateProject("p1", { hostId: "box" });
    // Optimistic: the UI moves immediately.
    expect(project().hostId).toBe("box");
    await expect(pending).rejects.toThrow("Unknown host");
    expect(project().hostId).toBe("local");
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

    const first = useProjectStore.getState().updateProject("p1", { hostId: "box" });
    await useProjectStore.getState().updateProject("p1", { hostId: "other" });
    reject(new Error("nope"));
    await expect(first).rejects.toThrow("nope");
    expect(project().hostId).toBe("other");
  });
});
