import { describe, it, expect, vi } from "vitest";

// The route table pulls in modules that import electron, which isn't there
// outside the app.
vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => {}) },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
  screen: {},
  webContents: { fromId: () => null },
  Notification: class {},
}));

vi.mock("electron-updater", () => ({
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
}));

import {
  REMOTE_CONTROL_ALLOWLIST,
  handleRelayedControlRequest,
  isRemoteAllowed,
} from "./control-relay";
import { routes } from "./routes";
import type { ControlDeps } from "./routes/types";
import type { ProjectInfo } from "./persistence";

/** A concrete path for a route pattern, every `:param` filled in. */
const sample = (path: string) => path.replace(/:[^/]+/g, "x1");

function project(id: string, hostId: string): ProjectInfo {
  return {
    id,
    name: id,
    path: "/repo",
    hostId,
    workspaces: [{ path: "/repo", branch: "main", isMain: true, name: null }],
  } as unknown as ProjectInfo;
}

function deps(): ControlDeps {
  return {
    projectManager: {
      getProjects: async () => [project("local-p", "local"), project("box-p", "box")],
    },
    layoutPersistence: null,
    githubManager: null,
    linearManager: null,
  } as unknown as ControlDeps;
}

describe("isRemoteAllowed", () => {
  it.each([
    ["GET", "/context"],
    ["GET", "/projects"],
    ["GET", "/projects/p1"],
    ["GET", "/projects/p1/branches"],
    ["GET", "/projects/p1/workspaces"],
    ["POST", "/projects/p1/workspaces"],
    ["DELETE", "/projects/p1/workspaces"],
    ["POST", "/projects/p1/workspaces/batch"],
    ["POST", "/projects/p1/workspaces/rename"],
    ["POST", "/projects/p1/workspaces/hidden"],
    ["POST", "/projects/p1/workspaces/reorder"],
    ["POST", "/projects/p1/workspaces/folder"],
    ["GET", "/projects/p1/folders"],
    ["POST", "/projects/p1/folders"],
    ["POST", "/projects/p1/folders/f1/rename"],
    ["POST", "/projects/p1/folders/f1/parent"],
    ["DELETE", "/projects/p1/folders/f1"],
    ["GET", "/projects/p1/issues"],
    ["POST", "/projects/p1/issues"],
    ["GET", "/projects/p1/issues/ENG-1"],
    ["GET", "/projects/p1/workspaces/issues"],
    ["POST", "/projects/p1/workspaces/issues"],
    ["DELETE", "/projects/p1/workspaces/issues"],
    ["GET", "/agents"],
    ["POST", "/agents"],
    ["GET", "//projects/p1/"],
  ])("allows %s %s", (method, path) => {
    expect(isRemoteAllowed(method, path)).toBe(true);
  });

  it.each([
    ["POST", "/projects"],
    ["DELETE", "/projects/p1"],
    ["POST", "/projects/p1/update"],
    ["POST", "/projects/reorder"],
    ["POST", "/projects/p1/workspaces/convert-main"],
    ["GET", "/projects/p1/workspaces/quick-merge"],
    ["POST", "/projects/p1/workspaces/quick-merge"],
    ["POST", "/sessions/send"],
    ["POST", "/sessions/end"],
    ["DELETE", "/agents/a1"],
    ["POST", "/agents/a1/rename"],
    ["GET", "/panes"],
    ["GET", "/processes"],
    ["GET", "/projects/p1/issues/ENG-1/extra"],
    ["PUT", "/agents"],
  ])("refuses %s %s", (method, path) => {
    expect(isRemoteAllowed(method, path)).toBe(false);
  });

  it("has no entry that matches no route in the table", () => {
    for (const entry of REMOTE_CONTROL_ALLOWLIST) {
      const matched = routes.some(
        (r) => r.method === entry.method && entry.pattern.test(sample(r.path)),
      );
      expect(matched, `${entry.method} ${entry.pattern}`).toBe(true);
    }
  });
});

describe("handleRelayedControlRequest", () => {
  it("refuses a route off the allowlist with 403, without dispatching", async () => {
    const getProjects = vi.fn();
    const result = await handleRelayedControlRequest(
      { ...deps(), projectManager: { getProjects } } as unknown as ControlDeps,
      "box",
      { method: "DELETE", path: "/projects/p1?x=1", body: undefined },
    );
    expect(result).toEqual({
      status: 403,
      body: { error: "DELETE /projects/p1 isn't available from remote hosts" },
    });
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("runs an allowed route as the calling host and captures its answer", async () => {
    const result = await handleRelayedControlRequest(deps(), "box", {
      method: "GET",
      path: "/context?cwd=%2Frepo%2Fsrc",
      body: undefined,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ projectId: "box-p" });
  });

  it("answers 404 for an allowed path no route handled", async () => {
    const result = await handleRelayedControlRequest(
      { ...deps(), projectManager: { getProjects: async () => [] } } as unknown as ControlDeps,
      "box",
      { method: "GET", path: "/projects/missing", body: undefined },
    );
    expect(result.status).toBe(404);
  });

  it("answers 500 when the route throws before answering", async () => {
    const result = await handleRelayedControlRequest(
      {
        ...deps(),
        projectManager: {
          getProjects: async () => {
            throw new Error("disk on fire");
          },
        },
      } as unknown as ControlDeps,
      "box",
      { method: "GET", path: "/context?cwd=/repo", body: undefined },
    );
    expect(result).toEqual({ status: 500, body: { error: "disk on fire" } });
  });
});
