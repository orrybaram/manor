import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore, type ProjectGroupInfo, type ProjectInfo } from "../project-store";
import { useToastStore } from "../toast-store";

// Linked-project groups (ADR-192): the store's link and unlink actions, and
// the collapsed-group key they leave behind.

const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  link: vi.fn(),
  unlink: vi.fn(),
  unlinkGroup: vi.fn(),
  updateGroup: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  selectWorkspace: vi.fn(),
};

// The collapsed set is localStorage-backed; this suite runs without a DOM.
vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

const GROUP: ProjectGroupInfo = {
  id: "g1",
  name: "App",
  memberIds: ["local-app", "box-app"],
  lastUsedHostId: "local",
};

function project(id: string, hostId: string, group: ProjectGroupInfo | null): ProjectInfo {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    defaultBranch: "main",
    workspaces: [{ path: `/code/${id}`, branch: "main", isMain: true, name: null }],
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
    folders: [],
    sidebarOrder: [],
    group,
  };
}

const linked = () => [project("local-app", "local", GROUP), project("box-app", "box", GROUP)];
const unlinked = () => [project("local-app", "local", null), project("box-app", "box", null)];

describe("linked-project groups in the project store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    useProjectStore.setState({
      projects: linked(),
      selectedProjectIndex: 0,
      collapsedProjectIds: new Set(["g1", "box-app"]),
    });
  });

  it("expands a member's group along with the member", () => {
    useProjectStore.getState().setProjectExpanded("box-app");
    expect(useProjectStore.getState().collapsedProjectIds.size).toBe(0);
  });

  it("drops a dissolved group's collapsed key after Unlink All", async () => {
    api.getAll.mockResolvedValue(unlinked());

    await useProjectStore.getState().unlinkGroup("g1");

    expect(api.unlinkGroup).toHaveBeenCalledWith("g1");
    expect([...useProjectStore.getState().collapsedProjectIds]).toEqual(["box-app"]);
  });

  it("keeps the collapsed key of a group that survives an unlink", async () => {
    api.getAll.mockResolvedValue(linked());

    await useProjectStore.getState().unlinkProject("local-app");

    expect(useProjectStore.getState().collapsedProjectIds.has("g1")).toBe(true);
  });

  it("shows an error toast when unlinking fails", async () => {
    api.unlink.mockRejectedValueOnce(new Error("nope"));
    api.unlinkGroup.mockRejectedValueOnce(new Error("nope"));

    await useProjectStore.getState().unlinkProject("local-app");
    await useProjectStore.getState().unlinkGroup("g1");

    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((t) => [t.status, t.message, t.detail])).toEqual([
      ["error", "Couldn't unlink project", "nope"],
      ["error", "Couldn't unlink projects", "nope"],
    ]);
    expect(api.getAll).not.toHaveBeenCalled();
  });

  describe("shared settings (ticket 2)", () => {
    const byId = (id: string) => useProjectStore.getState().projects.find((p) => p.id === id)!;

    it("shows a group edit on every member, keeping each member's workspaces", async () => {
      const pr = { number: 1 } as unknown as ProjectInfo["workspaces"][number]["pr"];
      useProjectStore.setState((s) => ({
        projects: s.projects.map((p) => ({
          ...p,
          workspaces: p.workspaces.map((ws) => ({ ...ws, pr })),
        })),
      }));
      const renamed = { ...GROUP, name: "Renamed" };
      api.updateGroup.mockResolvedValue([
        { ...project("local-app", "local", renamed), name: "Renamed", color: "green" },
        { ...project("box-app", "box", renamed), name: "Renamed", color: "green" },
      ]);

      const pending = useProjectStore.getState().updateGroup("g1", { name: "Renamed", color: "green" });
      // Optimistic: both members at once, before main answers.
      expect(byId("box-app")).toMatchObject({ name: "Renamed", color: "green", group: { name: "Renamed" } });
      await pending;

      expect(api.updateGroup).toHaveBeenCalledWith("g1", { name: "Renamed", color: "green" });
      for (const id of ["local-app", "box-app"]) {
        expect(byId(id)).toMatchObject({ name: "Renamed", color: "green", group: renamed });
        expect(byId(id).workspaces[0].pr).toBe(pr);
      }
    });

    it("rolls a failed group edit back and shows a toast", async () => {
      api.updateGroup.mockRejectedValueOnce(new Error("nope"));

      await useProjectStore.getState().updateGroup("g1", { name: "Renamed", color: "green" });

      expect(byId("local-app")).toMatchObject({ name: "local-app", color: null, group: GROUP });
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        "Couldn't save shared settings",
      ]);
    });

    it("sends a grouped project's shared fields to the group and the rest to the project", async () => {
      api.updateGroup.mockResolvedValue(linked());
      api.update.mockResolvedValue(null);

      await useProjectStore.getState().updateProject("box-app", { color: "red", worktreePath: "~/wt" });

      expect(api.updateGroup).toHaveBeenCalledWith("g1", { color: "red" });
      expect(api.update).toHaveBeenCalledWith("box-app", { worktreePath: "~/wt" });
    });

    it("updates an unlinked project's shared fields on the project itself", async () => {
      useProjectStore.setState({ projects: unlinked() });
      api.update.mockResolvedValue(null);

      await useProjectStore.getState().updateProject("box-app", { color: "red" });

      expect(api.update).toHaveBeenCalledWith("box-app", { color: "red" });
      expect(api.updateGroup).not.toHaveBeenCalled();
    });
  });
});
