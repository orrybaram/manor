import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import { clearRecords, toastStore } from "../../toast/toast-store";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> })
  .electronAPI;
const originalProjects = electronAPI.projects;

/** Failures are not empty lists, and mutations say they failed. */
describe("project store failures", () => {
  beforeEach(() => {
    clearRecords();
    useProjectStore.setState({
      projects: [],
      initialLoadDone: false,
      loadError: null,
      loading: false,
    } as never);
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
  });

  it("a failed first load records why and is not a finished (empty) load", async () => {
    electronAPI.projects = {
      getAll: vi
        .fn()
        .mockRejectedValue(
          new Error("Error invoking remote method 'projects:getAll': Error: disk on fire"),
        ),
      getSelectedIndex: vi.fn().mockResolvedValue(0),
    };

    await useProjectStore.getState().loadProjects();

    const s = useProjectStore.getState();
    expect(s.loadError).toBe("disk on fire");
    expect(s.initialLoadDone).toBe(false);
    expect(s.loading).toBe(false);
  });

  it("a later successful load clears the error", async () => {
    useProjectStore.setState({ loadError: "disk on fire" });
    electronAPI.projects = {
      getAll: vi.fn().mockResolvedValue([]),
      getSelectedIndex: vi.fn().mockResolvedValue(0),
    };

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().loadError).toBeNull();
    expect(useProjectStore.getState().initialLoadDone).toBe(true);
  });

  it("a failed re-read after a good load keeps the projects and sets no error", async () => {
    const p = { id: "p1", name: "app", path: "/r", hostId: "local", workspaces: [] };
    useProjectStore.setState({ projects: [p], initialLoadDone: true } as never);
    electronAPI.projects = {
      getAll: vi.fn().mockRejectedValue(new Error("busy")),
      getSelectedIndex: vi.fn().mockResolvedValue(0),
    };

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().projects).toEqual([p]);
    expect(useProjectStore.getState().loadError).toBeNull();
  });

  it("removeProject toasts and rethrows, removing nothing", async () => {
    const p = { id: "p1", name: "app", path: "/r", hostId: "local", workspaces: [] };
    useProjectStore.setState({ projects: [p] } as never);
    electronAPI.projects = { remove: vi.fn().mockRejectedValue(new Error("locked")) };

    await expect(useProjectStore.getState().removeProject("p1")).rejects.toThrow("locked");

    expect(useProjectStore.getState().projects).toHaveLength(1);
    const toast = toastStore.getState().toasts[0];
    expect(toast.message).toBe("Couldn't remove app");
    expect(toast.detail).toBe("locked");
  });

  it("renameWorkspace, setWorkspaceHidden and createWorkspaceFolder toast their failures", async () => {
    electronAPI.projects = {
      renameWorkspace: vi.fn().mockRejectedValue(new Error("a")),
      setWorkspaceHidden: vi.fn().mockRejectedValue(new Error("b")),
      createWorkspaceFolder: vi.fn().mockRejectedValue(new Error("c")),
    };
    const store = useProjectStore.getState();

    await expect(store.renameWorkspace("p1", "/w", "x")).rejects.toThrow("a");
    await expect(store.setWorkspaceHidden("p1", "/w", true)).rejects.toThrow("b");
    await expect(store.createWorkspaceFolder("p1", "F")).rejects.toThrow("c");

    expect(toastStore.getState().toasts.map((t) => t.message)).toEqual([
      "Couldn't rename workspace",
      "Couldn't hide workspace",
      'Couldn\'t create folder "F"',
    ]);
  });
});
