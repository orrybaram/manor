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
});
