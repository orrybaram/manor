import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore, type ProjectInfo } from "../project-store";
import { useHostProfileStore } from "../host-profile-store";
import { useToastStore } from "../toast-store";

// "In a new pod" (ADR-235 D4): the toast lifecycle of `openInNewHost`, the
// failure toast's Retry and "Delete the pod", and the Set up on fallback.

vi.mock("../auto-join", () => ({
  runAutoJoin: vi.fn(async () => {}),
  startAutoJoin: vi.fn(async () => {}),
}));

const unsubscribe = vi.fn();
const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  openInNewHost: vi.fn(),
  getOriginUrl: vi.fn(),
  select: vi.fn(),
  onCloneProgress: vi.fn(() => unsubscribe),
};

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api, hosts: {} },
});

function project(id: string, hostId: string): ProjectInfo {
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
    group: null,
  };
}

const toasts = () => useToastStore.getState().toasts;
const REPO = "git@github.com:me/app.git";

describe("openInNewHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] } as never);
    useHostProfileStore.setState({
      profiles: [{ id: "hp-1", name: "Work cluster", templateId: "kubernetes", values: {} }],
    });
    const app = project("app", "local");
    useProjectStore.setState({
      projects: [app],
      selectedProjectIndex: 0,
      transferDialog: null,
      deletePodDialog: null,
    });
    api.getAll.mockResolvedValue([app, project("app-pod", "pod-1")]);
  });

  it("shows a loading toast, then success, and loads the project", async () => {
    let finish!: (v: unknown) => void;
    api.openInNewHost.mockReturnValue(new Promise((r) => (finish = r)));

    const done = useProjectStore.getState().openInNewHost({ profileId: "hp-1", repoUrl: REPO });
    expect(toasts()).toMatchObject([
      { status: "loading", message: "Starting Work cluster pod…", persistent: true },
    ]);

    finish({ ok: true, project: project("app-pod", "pod-1"), hostId: "pod-1" });
    expect(await done).toMatchObject({ id: "app-pod" });
    expect(toasts()).toMatchObject([{ status: "success" }]);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["app", "app-pod"]);
  });

  it("keeps the pod on a failure and offers Retry from the failed stage", async () => {
    api.openInNewHost.mockResolvedValueOnce({
      ok: false,
      stage: "clone",
      hostId: "pod-1",
      error: "denied",
    });

    expect(
      await useProjectStore.getState().openInNewHost({ profileId: "hp-1", repoUrl: REPO }),
    ).toBeNull();
    expect(toasts()).toMatchObject([
      {
        status: "error",
        detail: "denied",
        action: { label: "Retry" },
        secondaryAction: { label: "Delete the pod" },
      },
    ]);

    api.openInNewHost.mockResolvedValueOnce({
      ok: true,
      project: project("app-pod", "pod-1"),
      hostId: "pod-1",
    });
    toasts()[0].action?.onClick();
    await vi.waitFor(() => expect(api.openInNewHost).toHaveBeenCalledTimes(2));
    expect(api.openInNewHost).toHaveBeenLastCalledWith({
      profileId: "hp-1",
      repoUrl: REPO,
      retryFrom: { hostId: "pod-1", stage: "clone" },
    });
  });

  it("opens the typed confirm for Delete the pod", async () => {
    api.openInNewHost.mockResolvedValueOnce({
      ok: false,
      stage: "up",
      hostId: "pod-1",
      error: "no quota",
    });
    await useProjectStore.getState().openInNewHost({ profileId: "hp-1", repoUrl: REPO });

    toasts()[0].secondaryAction?.onClick();
    expect(useProjectStore.getState().deletePodDialog).toEqual({ hostId: "pod-1" });
    expect(toasts()).toEqual([]);
  });

  it("sets a project up from its origin, and hands needsInput to the fallback dialog", async () => {
    api.getOriginUrl.mockResolvedValue(REPO);
    api.openInNewHost.mockResolvedValueOnce({
      ok: false,
      stage: "clone",
      hostId: "pod-1",
      error: "needs input",
      needsInput: { reason: "dir-taken", repoUrl: REPO, targetDir: "~/code/app" },
    });

    await useProjectStore.getState().openInNewHost({ profileId: "hp-1", sourceProjectId: "app" });

    expect(api.openInNewHost).toHaveBeenCalledWith({
      profileId: "hp-1",
      sourceProjectId: "app",
      repoUrl: REPO,
    });
    expect(toasts()).toEqual([]);
    expect(useProjectStore.getState().transferDialog).toMatchObject({
      projectId: "app",
      hostId: "pod-1",
      mode: "setUp",
      reason: "dir-taken",
      targetDir: "~/code/app",
      newHost: { hostId: "pod-1", profileId: "hp-1" },
    });
  });

  it("finishes the fallback dialog's set up on the pod through openInNewHost", async () => {
    useProjectStore.setState({ projects: [project("app", "local")] });
    const transfer = vi.fn();
    (window.electronAPI.projects as Record<string, unknown>).transfer = transfer;
    const overrides = { repoUrl: REPO, targetDir: "~/src/app" };
    api.openInNewHost.mockResolvedValueOnce({
      ok: false,
      stage: "clone",
      hostId: "pod-1",
      error: "fatal",
    });

    await useProjectStore
      .getState()
      .setUpOnHost("app", "pod-1", overrides, { hostId: "pod-1", profileId: "hp-1" });

    expect(transfer).not.toHaveBeenCalled();
    expect(api.openInNewHost).toHaveBeenCalledWith({
      profileId: "hp-1",
      sourceProjectId: "app",
      repoUrl: REPO,
      retryFrom: { hostId: "pod-1", stage: "clone", overrides },
    });
    // Its Retry keeps the answer.
    api.openInNewHost.mockResolvedValueOnce({ ok: false, stage: "up", error: "x" });
    toasts()[0].action!.onClick();
    await vi.waitFor(() => expect(api.openInNewHost).toHaveBeenCalledTimes(2));
    expect(api.openInNewHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryFrom: { hostId: "pod-1", stage: "clone", overrides } }),
    );
  });

  it("says so when a project to set up has no origin", async () => {
    api.getOriginUrl.mockResolvedValue(null);

    expect(
      await useProjectStore.getState().openInNewHost({ profileId: "hp-1", sourceProjectId: "app" }),
    ).toBeNull();
    expect(api.openInNewHost).not.toHaveBeenCalled();
    expect(toasts()).toMatchObject([{ status: "error", detail: expect.stringMatching(/origin/) }]);
  });
});
