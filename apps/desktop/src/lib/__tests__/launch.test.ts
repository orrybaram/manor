/**
 * A phone opened while its desktop is away boots with nothing: every read
 * fails. The first resync after it connects launches again, so the phone
 * reopens the workspace it had open instead of an empty "new agent" screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { launch, resyncAfterReconnect } from "../launch";

const electronAPI = (window as unknown as { electronAPI: Record<string, Record<string, unknown>> })
  .electronAPI;
const originalProjects = electronAPI.projects;
const originalGetAll = electronAPI.layout.getAll;
const originalReconcile = electronAPI.agents.reconcileStale;

const WS_PATH = "/repo/feature";
const PROJECT = {
  id: "p1",
  name: "app",
  path: "/repo",
  hostId: "local",
  selectedWorkspaceIndex: 1,
  workspaces: [
    { path: "/repo", branch: "main" },
    { path: WS_PATH, branch: "feature" },
  ],
};

const away = () => Promise.reject(new Error("The desktop is not reachable"));

function desktopAway(): void {
  electronAPI.projects = { getAll: vi.fn(away), getSelectedIndex: vi.fn(away) };
  electronAPI.layout.getAll = vi.fn(away);
}

function desktopBack(): void {
  electronAPI.projects = {
    getAll: vi.fn().mockResolvedValue([PROJECT]),
    getSelectedIndex: vi.fn().mockResolvedValue(0),
  };
  electronAPI.layout.getAll = vi.fn().mockResolvedValue({});
}

describe("launch", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    electronAPI.agents.reconcileStale = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: [],
      selectedProjectIndex: 0,
      initialLoadDone: false,
      loadError: null,
      loading: false,
    } as never);
    useAppStore.setState({
      activeWorkspacePath: null,
      layoutLoadError: null,
      workspaceLayouts: {},
      layoutVersions: {},
    });
  });

  afterEach(() => {
    electronAPI.projects = originalProjects;
    electronAPI.layout.getAll = originalGetAll;
    electronAPI.agents.reconcileStale = originalReconcile;
    vi.restoreAllMocks();
  });

  it("opens the selected workspace", async () => {
    desktopBack();
    await launch();
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_PATH);
  });

  it("launches again on the first resync after a boot that read nothing", async () => {
    desktopAway();
    await launch();
    expect(useAppStore.getState().activeWorkspacePath).toBeNull();
    expect(useProjectStore.getState().loadError).not.toBeNull();
    expect(useAppStore.getState().layoutLoadError).not.toBeNull();

    desktopBack();
    await resyncAfterReconnect();

    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_PATH);
    expect(useProjectStore.getState().loadError).toBeNull();
    expect(useAppStore.getState().layoutLoadError).toBeNull();
  });

  it("leaves a workspace opened since the failed boot alone", async () => {
    desktopAway();
    await launch();
    useAppStore.getState().setActiveWorkspace("/repo", "local");

    desktopBack();
    await resyncAfterReconnect();

    expect(useAppStore.getState().activeWorkspacePath).toBe("/repo");
  });

  it("only re-reads on a resync after a good boot", async () => {
    desktopBack();
    await launch();
    useAppStore.getState().setActiveWorkspace("/repo", "local");

    await resyncAfterReconnect();

    expect(useAppStore.getState().activeWorkspacePath).toBe("/repo");
    expect(electronAPI.projects.getAll).toHaveBeenCalledTimes(2);
  });
});
