import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useHostStore, type HostStatusInfo } from "../host-store";
import { useProjectStore, type ProjectGroupInfo, type ProjectInfo } from "../project-store";
import { defaultHostChoice, workspaceHostChoices } from "../../lib/workspace-host-choices";

// The New Workspace host picker for a linked group (ADR-192 ticket 3): which
// member a workspace is created in, the remembered last-used host, and a
// disconnected host shown but not choosable.

const api = {
  createWorktree: vi.fn(),
  setGroupLastUsedHost: vi.fn(async () => {}),
  selectWorkspace: vi.fn(),
  select: vi.fn(),
  onWorktreeSetupProgress: vi.fn(() => vi.fn()),
};

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

function group(lastUsedHostId: string | null): ProjectGroupInfo {
  return { id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId };
}

function project(
  id: string,
  hostId: string,
  groupInfo: ProjectGroupInfo | null,
  extraWorkspaces: string[] = [],
): ProjectInfo {
  const ws = (path: string, isMain: boolean) => ({
    path,
    branch: isMain ? "main" : path.split("/").pop()!,
    isMain,
    name: null,
  });
  return {
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    defaultBranch: "main",
    workspaces: [ws(`/code/${id}`, true), ...extraWorkspaces.map((p) => ws(p, false))],
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
    group: groupInfo,
  };
}

function seed(lastUsedHostId: string | null, grouped = true): void {
  const g = grouped ? group(lastUsedHostId) : null;
  useProjectStore.setState({
    projects: [project("local-app", "local", g), project("box-app", "box", g)],
    selectedProjectIndex: 0,
  });
}

function setBox(status: HostStatusInfo["status"]): void {
  useHostStore.setState({
    hosts: [{ hostId: "box", spec: { kind: "ssh", target: "me@box" }, status }],
  });
}

/** The picker's choices for the dialog opened on `projectId`, as it computes them. */
function pickerFor(projectId: string) {
  const { projects } = useProjectStore.getState();
  const opened = projects.find((p) => p.id === projectId);
  return workspaceHostChoices(opened, projects, useHostStore.getState().hosts);
}

function startingMember(projectId: string, preferred?: string): string {
  const choices = pickerFor(projectId)!;
  const opened = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
  return defaultHostChoice(choices, opened.group!.lastUsedHostId, projectId, preferred);
}

describe("New Workspace host picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ workspaceLayouts: {}, activeWorkspacePath: null });
    setBox("connected");
  });

  it("offers one choice per member host, in section order", () => {
    seed("local");

    expect(pickerFor("local-app")).toEqual([
      { projectId: "local-app", hostId: "local", disabledReason: null },
      { projectId: "box-app", hostId: "box", disabledReason: null },
    ]);
  });

  it("shows no picker for an unlinked project", () => {
    seed(null, false);

    expect(pickerFor("local-app")).toBeNull();
  });

  it("creates in the chosen member and remembers its host for next time", async () => {
    seed("local");
    api.createWorktree.mockResolvedValue(
      project("box-app", "box", group("local"), ["/code/box-app/feat"]),
    );
    const chosen = pickerFor("local-app")!.find((c) => c.hostId === "box")!;

    const wsPath = await useProjectStore
      .getState()
      .createWorktree(chosen.projectId, "feat", "feat", undefined, undefined, "main");

    expect(wsPath).toBe("/code/box-app/feat");
    expect(api.createWorktree).toHaveBeenCalledWith(
      "box-app",
      "feat",
      "feat",
      undefined,
      "main",
      undefined,
    );
    await vi.waitFor(() => expect(api.setGroupLastUsedHost).toHaveBeenCalledWith("g1", "box"));
    // Every member's summary now starts the picker on the box.
    await vi.waitFor(() =>
      expect(
        useProjectStore.getState().projects.map((p) => p.group?.lastUsedHostId),
      ).toEqual(["box", "box"]),
    );
    expect(startingMember("local-app")).toBe("box-app");
  });

  it("starts on the group's last-used host, whichever member it was opened for", () => {
    seed("box");

    expect(startingMember("local-app")).toBe("box-app");
    expect(startingMember("box-app")).toBe("box-app");
  });

  it("starts on the member whose section it was opened from", () => {
    seed("box");

    expect(startingMember("local-app", "local-app")).toBe("local-app");
  });

  it("shows a disconnected host disabled, with the reason, and starts elsewhere", () => {
    seed("box");
    setBox("reconnecting");

    const box = pickerFor("local-app")!.find((c) => c.hostId === "box")!;

    expect(box.disabledReason).toMatch(/^me@box isn't connected \(reconnecting/);
    expect(startingMember("local-app")).toBe("local-app");
    // Even the section it was opened from can't win while its host is away.
    expect(startingMember("local-app", "box-app")).toBe("local-app");
  });

  it("doesn't record a host that is already the last used", async () => {
    seed("local");
    api.createWorktree.mockResolvedValue(
      project("local-app", "local", group("local"), ["/code/local-app/feat"]),
    );

    await useProjectStore.getState().createWorktree("local-app", "feat", "feat");

    expect(api.setGroupLastUsedHost).not.toHaveBeenCalled();
  });

  it("keeps the old default when recording the host fails", async () => {
    seed("local");
    api.setGroupLastUsedHost.mockRejectedValueOnce(new Error("nope"));

    await useProjectStore.getState().setGroupLastUsedHost("g1", "box");

    expect(startingMember("local-app")).toBe("local-app");
  });
});
