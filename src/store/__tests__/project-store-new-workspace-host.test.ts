import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useHostStore, type HostStatusInfo } from "../host-store";
import { useProjectStore, type ProjectGroupInfo, type ProjectInfo } from "../project-store";
import { hostLabel } from "../../lib/hosts";
import {
  checkBranchOnHost,
  projectForSelectValue,
  projectSelectOptions,
  reseedBaseBranch,
} from "../../lib/new-workspace";
import { startingMemberId, workspaceHostChoices } from "../../lib/workspace-host-choices";

// The New Workspace dialog for a linked group (ADR-192 ticket 3): which
// member a workspace is created in, the remembered last-used host, a
// disconnected host shown but not choosable, the base branch after a host
// change, and the "push it first" gate. Each decision is read off the store
// the way the dialog reads it.

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
  defaultBranch = "main",
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
    defaultBranch,
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

/** `local-app` (on `main`) and `box-app` (on `master`), linked unless `grouped` is false. */
function seed(lastUsedHostId: string | null, grouped = true): void {
  const g = grouped ? group(lastUsedHostId) : null;
  useProjectStore.setState({
    projects: [
      project("local-app", "local", g),
      project("box-app", "box", g, [], "master"),
    ],
    selectedProjectIndex: 0,
  });
}

function member(id: string): ProjectInfo {
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
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

/** The member the dialog starts on, opened for `projectId`. */
function startingMember(projectId: string, preferred?: string): string {
  const { projects } = useProjectStore.getState();
  return startingMemberId(projectId, projects, useHostStore.getState().hosts, preferred);
}

/** The dialog's branch gate for `memberId`, with that host's branch lists. */
function branchGate(
  memberId: string,
  mode: "new" | "existing",
  branch: string,
  lists: { local?: string[]; remote?: string[] },
) {
  const chosen = member(memberId);
  return checkBranchOnHost({
    mode,
    branch,
    defaultBranch: chosen.defaultBranch,
    localBranches: lists.local,
    remoteBranches: lists.remote,
    hostName: hostLabel(chosen.hostId, useHostStore.getState().hosts),
  });
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
      .createWorktree(chosen.projectId, "feat", "feat", { baseBranch: "main" });

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

  it("lists a linked group once in the project select, and picks its member from there", () => {
    seed("box");
    useProjectStore.setState((st) => ({
      projects: [...st.projects, project("other", "local", null)],
    }));
    const { projects } = useProjectStore.getState();

    expect(projectSelectOptions(projects)).toEqual([
      { value: "group:g1", label: "App" },
      { value: "project:other", label: "other" },
    ]);
    const opened = projectForSelectValue("group:g1", projects)!;
    expect(startingMember(opened)).toBe("box-app");
    expect(projectForSelectValue("project:other", projects)).toBe("other");
    // A bare id is neither kind of value.
    expect(projectForSelectValue("g1", projects)).toBeUndefined();
  });

  it("reseeds the base branch from the chosen member unless the user picked one", () => {
    seed("local");

    expect(reseedBaseBranch("main", false, member("box-app"))).toBe("master");
    expect(reseedBaseBranch("origin/feat", true, member("box-app"))).toBe("origin/feat");
  });

  it("doesn't flag the chosen host's own default branch after a host change", () => {
    seed("local");
    const base = reseedBaseBranch("main", false, member("box-app"));

    expect(branchGate("box-app", "new", base, { local: ["master"], remote: ["master"] })).toEqual({
      state: "ok",
    });
  });

  it("says a branch the chosen host doesn't have must be pushed first", () => {
    seed("local");

    const gate = branchGate("box-app", "existing", "feat", {
      local: ["master"],
      remote: ["master", "other"],
    });

    expect(gate).toEqual({
      state: "missing",
      message: `"feat" isn't on me@box. Push it to origin first, then create the workspace there.`,
    });
    expect(
      branchGate("box-app", "new", "origin/feat", { local: [], remote: ["feat"] }).state,
    ).toBe("ok");
  });

  it("holds Create until the chosen host's branch lists load, except for the default base", () => {
    seed("local");

    expect(branchGate("box-app", "new", "origin/feat", {}).state).toBe("pending");
    expect(branchGate("box-app", "existing", "feat", { local: ["feat"] }).state).toBe("pending");
    expect(branchGate("box-app", "new", "origin/master", {}).state).toBe("ok");
  });

  it("with no remote branches, only a new branch on the default base passes", () => {
    seed("local");
    const empty = { local: ["master"], remote: [] };

    expect(branchGate("box-app", "new", "master", empty).state).toBe("ok");
    expect(branchGate("box-app", "new", "origin/feat", empty).state).toBe("missing");
  });
});
