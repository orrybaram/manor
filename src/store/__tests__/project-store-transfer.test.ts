import { describe, it, expect, beforeEach, vi } from "vitest";
import { useHostStore } from "../host-store";
import { useProjectStore, type ProjectInfo } from "../project-store";
import { useToastStore } from "../toast-store";

// One-click Copy to / Move to (ADR-213 ticket 3): the progress toast's
// lifecycle, `needsInput` handing off to the fallback dialog's state, and a
// thrown transfer becoming an error toast that can open the same dialog.

vi.mock("../auto-join", () => ({
  runAutoJoin: vi.fn(async () => {}),
  startAutoJoin: vi.fn(async () => {}),
}));

let progress: ((e: { status: string; message?: string }) => void) | null = null;
const unsubscribe = vi.fn();

const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  transfer: vi.fn(),
  remove: vi.fn(async () => {}),
  keepSeparate: vi.fn(async () => {}),
  select: vi.fn(),
  selectWorkspace: vi.fn(),
  onCloneProgress: vi.fn((cb: typeof progress) => {
    progress = cb;
    return unsubscribe;
  }),
};
const hostsApi = { healthCheck: vi.fn() };

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api, hosts: hostsApi },
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

describe("transferProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progress = null;
    useToastStore.setState({ toasts: [] } as never);
    useHostStore.setState({
      hosts: [{ hostId: "box", spec: { kind: "ssh", target: "me@box" }, status: "connected" }],
    });
    const app = project("app", "local");
    useProjectStore.setState({ projects: [app], selectedProjectIndex: 0, transferDialog: null });
    api.getAll.mockResolvedValue([app, project("app-box", "box")]);
    hostsApi.healthCheck.mockResolvedValue([]);
  });

  it("shows progress, then success, and refreshes projects", async () => {
    let finish!: (v: unknown) => void;
    api.transfer.mockReturnValue(new Promise((r) => (finish = r)));

    const done = useProjectStore.getState().transferProject("app", "box", "copy");
    expect(toasts()).toMatchObject([
      { id: "transfer-app", message: "Copying app to me@box…", status: "loading", persistent: true },
    ]);
    progress?.({ status: "progress", message: "Receiving objects: 50%" });
    expect(toasts()[0].detail).toBe("Receiving objects: 50%");

    finish({ ok: true, project: project("app-box", "box") });
    await done;

    expect(api.transfer).toHaveBeenCalledWith({ projectId: "app", hostId: "box", mode: "copy" });
    expect(unsubscribe).toHaveBeenCalled();
    expect(toasts()).toMatchObject([
      { message: "app is set up on me@box", status: "success", action: { label: "Remove from This machine" } },
    ]);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["app", "app-box"]);
    expect(hostsApi.healthCheck).toHaveBeenCalledWith("box", "/code/app-box");
  });

  it("setUpOnHost is a copy, and its toast action opens the remove-from-host confirm", async () => {
    api.transfer.mockResolvedValue({ ok: true, project: project("app-box", "box") });

    await useProjectStore.getState().setUpOnHost("app", "box");

    expect(api.transfer).toHaveBeenCalledWith({ projectId: "app", hostId: "box", mode: "copy" });
    expect(useProjectStore.getState().removeFromHostDialog).toBeNull();
    toasts()[0].action!.onClick();
    expect(useProjectStore.getState().removeFromHostDialog).toEqual({ projectId: "app" });
    expect(toasts()).toEqual([]);
    useProjectStore.getState().closeRemoveFromHost();
    expect(useProjectStore.getState().removeFromHostDialog).toBeNull();
  });

  it("a move's success toast has no remove action", async () => {
    api.transfer.mockResolvedValue({ ok: true, project: project("app", "box") });
    await useProjectStore.getState().transferProject("app", "box", "move");
    expect(toasts()[0]).toMatchObject({ message: "app is on me@box" });
    expect(toasts()[0].action).toBeUndefined();
  });

  it("removeFromHost removes the member and says where from", async () => {
    useProjectStore.setState({ projects: [project("app-box", "box")] });
    api.getAll.mockResolvedValue([]);

    await useProjectStore.getState().removeFromHost("app-box");

    expect(api.remove).toHaveBeenCalledWith("app-box");
    expect(toasts()).toMatchObject([{ message: "Removed app-box from me@box", status: "success" }]);
  });

  it("keepSeparate calls main and reloads", async () => {
    await useProjectStore.getState().keepSeparate("app");
    expect(api.keepSeparate).toHaveBeenCalledWith("app");
    expect(api.getAll).toHaveBeenCalled();
  });

  it("says Moving for a move, and skips the health check for this machine", async () => {
    const onBox = project("app", "box");
    useProjectStore.setState({ projects: [onBox] });
    api.getAll.mockResolvedValue([project("app", "local")]);
    api.transfer.mockResolvedValue({ ok: true, project: project("app", "local") });

    const done = useProjectStore.getState().transferProject("app", "local", "move");
    expect(toasts()[0].message).toBe("Moving app to This machine…");
    await done;

    expect(hostsApi.healthCheck).not.toHaveBeenCalled();
  });

  it("offers an Open settings action when the background health check fails", async () => {
    api.transfer.mockResolvedValue({ ok: true, project: project("app-box", "box") });
    hostsApi.healthCheck.mockResolvedValue([{ id: "agent", status: "fail" }]);

    await useProjectStore.getState().transferProject("app", "box", "copy");
    await vi.waitFor(() =>
      expect(toasts().map((t) => t.action?.label)).toContain("Open settings"),
    );
  });

  it("drops the toast and opens the dialog when main needs input", async () => {
    api.transfer.mockResolvedValue({
      ok: false,
      needsInput: {
        kind: "needsInput",
        reason: "dir-taken",
        repoUrl: "git@github.com:me/app.git",
        targetDir: "~/code/app",
        mode: "copy",
        hostId: "box",
      },
    });

    await useProjectStore.getState().transferProject("app", "box", "copy");

    expect(toasts()).toEqual([]);
    expect(useProjectStore.getState().transferDialog).toEqual({
      projectId: "app",
      hostId: "box",
      mode: "setUp",
      reason: "dir-taken",
      repoUrl: "git@github.com:me/app.git",
      targetDir: "~/code/app",
    });
  });

  it("turns a throw into an error toast that opens the dialog", async () => {
    api.transfer.mockRejectedValue(new Error("git clone exited with code 128"));

    await useProjectStore
      .getState()
      .transferProject("app", "box", "move", { repoUrl: "u", targetDir: "~/x" });

    expect(unsubscribe).toHaveBeenCalled();
    expect(api.transfer).toHaveBeenCalledWith({
      projectId: "app",
      hostId: "box",
      mode: "move",
      repoUrl: "u",
      targetDir: "~/x",
    });
    const [toast] = toasts();
    expect(toast).toMatchObject({
      status: "error",
      message: "Couldn't move app to me@box",
      detail: expect.stringContaining("git clone exited with code 128"),
    });
    expect(useProjectStore.getState().transferDialog).toBeNull();

    toast.action?.onClick();

    expect(toasts()).toEqual([]);
    expect(useProjectStore.getState().transferDialog).toMatchObject({
      reason: "failed",
      repoUrl: "u",
      targetDir: "~/x",
    });
  });

  it("opens the failed dialog with empty values when there was no plan", async () => {
    api.transfer.mockRejectedValue(new Error("boom"));

    await useProjectStore.getState().transferProject("app", "box", "copy");
    toasts()[0].action?.onClick();

    expect(useProjectStore.getState().transferDialog).toMatchObject({
      reason: "failed",
      repoUrl: null,
      targetDir: "",
    });
    useProjectStore.getState().closeTransferDialog();
    expect(useProjectStore.getState().transferDialog).toBeNull();
  });
});
