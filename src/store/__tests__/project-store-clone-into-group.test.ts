import { describe, it, expect, beforeEach, vi } from "vitest";
import { useHostStore, type HostStatusInfo } from "../host-store";
import { useProjectStore, type ProjectGroupInfo, type ProjectInfo } from "../project-store";
import { useToastStore } from "../toast-store";
import { clearLinkSuggestionsFor, offerLinkSuggestions } from "../link-suggestions";
import {
  hostsToCloneOnto,
  memberAfterClone,
  workspaceHostChoices,
} from "../../lib/workspace-host-choices";

// "Clone onto another host…" from the New Workspace host picker (ADR-192
// ticket 4): which hosts it offers, and that a clone joins the group and
// becomes the dialog's selection, while a cancelled or failed one leaves the
// group as it was. Each decision is read off the store the way the dialog
// reads it.

vi.mock("../link-suggestions", () => ({
  clearLinkSuggestionsFor: vi.fn(),
  offerLinkSuggestions: vi.fn(async () => {}),
  startLinkSuggestions: vi.fn(async () => {}),
}));

const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  clone: vi.fn(),
  link: vi.fn(),
  select: vi.fn(),
  selectWorkspace: vi.fn(),
};

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

function group(memberIds: string[]): ProjectGroupInfo {
  return { id: "g1", name: "App", memberIds, lastUsedHostId: "local" };
}

function project(id: string, hostId: string, groupInfo: ProjectGroupInfo | null): ProjectInfo {
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
    group: groupInfo,
  };
}

const TWO = group(["local-app", "box-app"]);
const THREE = group(["local-app", "box-app", "cloud-app"]);

/** `local-app` and `box-app`, linked unless `grouped` is false. */
function seed(grouped = true): ProjectInfo[] {
  const g = grouped ? TWO : null;
  const projects = [project("local-app", "local", g), project("box-app", "box", g)];
  useProjectStore.setState({ projects, selectedProjectIndex: 0 });
  api.getAll.mockResolvedValue(projects);
  return projects;
}

function setHosts(...ids: string[]): void {
  useHostStore.setState({
    hosts: ids.map(
      (hostId): HostStatusInfo => ({
        hostId,
        spec: { kind: "ssh", target: `me@${hostId}` },
        status: "connected",
      }),
    ),
  });
}

function setStatus(hostId: string, status: HostStatusInfo["status"]): void {
  useHostStore.setState((s) => ({
    hosts: s.hosts.map((h) => (h.hostId === hostId ? { ...h, status } : h)),
  }));
}

/** The hosts "Clone onto another host…" offers, opened on `projectId`. */
function cloneChoices(projectId: string) {
  const { projects } = useProjectStore.getState();
  const opened = projects.find((p) => p.id === projectId);
  return hostsToCloneOnto(opened, projects, useHostStore.getState().hosts);
}

function cloneTargets(projectId: string): string[] {
  return cloneChoices(projectId).map((c) => c.hostId);
}

const OPTS = { hostId: "cloud", repoUrl: "git@github.com:me/app.git", remoteDir: "~/code/app" };

describe("Clone onto another host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] } as never);
    setHosts("box", "cloud", "spare");
  });

  it("offers only registered hosts with no member in the group", () => {
    seed();

    expect(cloneTargets("local-app")).toEqual(["cloud", "spare"]);
    expect(cloneTargets("box-app")).toEqual(["cloud", "spare"]);
  });

  it("shows a host that can't connect disabled, with the reason", () => {
    seed();
    setStatus("cloud", "error");

    const cloud = cloneChoices("local-app").find((c) => c.hostId === "cloud")!;
    expect(cloud.disabledReason).toMatch(/^me@cloud is offline/);
  });

  it("still offers a host that is only disconnected, since the clone connects it", () => {
    seed();
    setStatus("cloud", "disconnected");
    setStatus("spare", "reconnecting");

    expect(cloneChoices("local-app").map((c) => c.disabledReason)).toEqual([null, null]);
  });

  it("offers nothing once every registered host has a member", () => {
    seed();
    setHosts("box");

    expect(cloneTargets("local-app")).toEqual([]);
  });

  it("offers nothing for an unlinked project", () => {
    seed(false);

    expect(cloneTargets("local-app")).toEqual([]);
  });

  it("links a successful clone into the group, and the dialog moves to it", async () => {
    const before = seed();
    const cloned = project("cloud-app", "cloud", null);
    api.clone.mockResolvedValue(cloned);
    api.link.mockResolvedValue(THREE);
    api.getAll.mockResolvedValue([
      ...before.map((p) => ({ ...p, group: THREE })),
      { ...cloned, group: THREE },
    ]);

    const result = await useProjectStore.getState().cloneIntoGroup("local-app", OPTS);

    expect(api.clone).toHaveBeenCalledWith({
      hostId: OPTS.hostId,
      repoUrl: OPTS.repoUrl,
      targetDir: OPTS.remoteDir,
      name: "local-app",
    });
    expect(api.link).toHaveBeenCalledWith("cloud-app", "local-app");
    // Any open suggestion naming either side is stale now.
    expect(clearLinkSuggestionsFor).toHaveBeenCalledWith(["cloud-app", "local-app"]);
    expect(offerLinkSuggestions).not.toHaveBeenCalled();
    expect(result.group?.memberIds).toEqual(["local-app", "box-app", "cloud-app"]);
    const selected = memberAfterClone(result, "g1");
    expect(selected).toBe("cloud-app");
    // The picker now offers the new host, and it has nothing left to clone onto but "spare".
    const { projects } = useProjectStore.getState();
    const opened = projects.find((p) => p.id === selected);
    expect(
      workspaceHostChoices(opened, projects, useHostStore.getState().hosts)?.map((c) => c.hostId),
    ).toEqual(["local", "box", "cloud"]);
    expect(cloneTargets("cloud-app")).toEqual(["spare"]);
  });

  it("leaves the group unchanged when the clone fails", async () => {
    const before = seed();
    api.clone.mockRejectedValue(new Error("git clone exited with code 128"));

    await expect(
      useProjectStore.getState().cloneIntoGroup("local-app", OPTS),
    ).rejects.toThrow("git clone exited with code 128");

    expect(api.link).not.toHaveBeenCalled();
    expect(offerLinkSuggestions).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects).toEqual(before);
    expect(cloneTargets("local-app")).toEqual(["cloud", "spare"]);
  });

  it("keeps a clone that couldn't be linked, unlinked, and says so", async () => {
    const before = seed();
    const cloned = project("cloud-app", "cloud", null);
    api.clone.mockResolvedValue(cloned);
    api.link.mockRejectedValue(new Error("already linked"));
    api.getAll.mockResolvedValue([...before, cloned]);

    const result = await useProjectStore.getState().cloneIntoGroup("local-app", OPTS);

    expect(result.group).toBeNull();
    expect(memberAfterClone(result, "g1")).toBeNull();
    expect(member("local-app").group).toEqual(TWO);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "Cloned, but couldn't link the projects",
    ]);
    // Standing alone, it gets the suggestions any new clone would.
    expect(offerLinkSuggestions).toHaveBeenCalledWith("cloud-app", expect.any(Function));
    expect(clearLinkSuggestionsFor).not.toHaveBeenCalled();
  });

  it("refuses to clone for a project that isn't linked", async () => {
    seed(false);

    await expect(useProjectStore.getState().cloneIntoGroup("local-app", OPTS)).rejects.toThrow();
    expect(api.clone).not.toHaveBeenCalled();
  });
});

function member(id: string): ProjectInfo {
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}
