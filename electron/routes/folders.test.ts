import { describe, it, expect, vi } from "vitest";

vi.mock("../renderer-bridge", () => ({
  notifyProjectsChanged: vi.fn(),
}));

import { notifyProjectsChanged } from "../renderer-bridge";
import { folderRoutes } from "./folders";
import type { ControlDeps, Route } from "./types";
import type { ProjectInfo, WorkspaceFolder } from "../persistence";

function route(method: Route["method"], path: string): Route {
  const found = folderRoutes.find(
    (r) => r.method === method && r.path === path,
  );
  if (!found) throw new Error(`No route ${method} ${path}`);
  return found;
}

/** A minimal, stateful ProjectManager stub covering exactly what folderRoutes calls. */
function makeProjectManager(projectId = "p1") {
  let folders: WorkspaceFolder[] = [];
  const workspaceFolderIds: Record<string, string | null> = {};

  return {
    async getProjects(): Promise<ProjectInfo[]> {
      return [
        {
          id: projectId,
          name: "Test Project",
          path: "/repo",
          defaultBranch: "main",
          workspaces: [],
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
          folders,
          sidebarOrder: [],
        },
      ];
    },
    createWorkspaceFolder(pid: string, name: string): WorkspaceFolder | null {
      if (pid !== projectId) return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      const folder: WorkspaceFolder = {
        id: `f${folders.length + 1}`,
        name: trimmed,
      };
      folders = [...folders, folder];
      return folder;
    },
    renameWorkspaceFolder(pid: string, folderId: string, name: string): void {
      const trimmed = name.trim();
      if (!trimmed) return;
      folders = folders.map((f) =>
        f.id === folderId ? { ...f, name: trimmed } : f,
      );
    },
    deleteWorkspaceFolder(_pid: string, folderId: string): void {
      folders = folders.filter((f) => f.id !== folderId);
    },
    setWorkspaceFolder(
      _pid: string,
      workspacePath: string,
      folderId: string | null,
    ): void {
      workspaceFolderIds[workspacePath] = folderId;
    },
    _workspaceFolderIds: workspaceFolderIds,
  };
}

function deps(pm: ReturnType<typeof makeProjectManager> | null): ControlDeps {
  return { projectManager: pm } as unknown as ControlDeps;
}

async function call(
  r: Route,
  d: ControlDeps,
  params: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  const calls: Array<{ status: number; body: unknown }> = [];
  await r.handler({
    deps: d,
    params,
    url: new URL("http://localhost/projects/p1/folders"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

describe("folder routes", () => {
  it("creates, renames, assigns, then deletes a folder end to end", async () => {
    const pm = makeProjectManager();
    const d = deps(pm);

    const created = await call(
      route("POST", "/projects/:projectId/folders"),
      d,
      { projectId: "p1" },
      { name: "  Feature Work  " },
    );
    expect(created.status).toBe(200);
    const folder = created.body as WorkspaceFolder;
    expect(folder.name).toBe("Feature Work");
    expect(notifyProjectsChanged).toHaveBeenCalledTimes(1);

    const renamed = await call(
      route("POST", "/projects/:projectId/folders/:folderId/rename"),
      d,
      { projectId: "p1", folderId: folder.id },
      { name: "Renamed" },
    );
    expect(renamed).toEqual({ status: 200, body: { ok: true } });
    expect(notifyProjectsChanged).toHaveBeenCalledTimes(2);

    const listed = await call(route("GET", "/projects/:projectId/folders"), d, {
      projectId: "p1",
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{ id: folder.id, name: "Renamed" }]);

    const assigned = await call(
      route("POST", "/projects/:projectId/workspaces/folder"),
      d,
      { projectId: "p1" },
      { workspacePath: "/repo/ws-1", folderId: folder.id },
    );
    expect(assigned).toEqual({ status: 200, body: { ok: true } });
    expect(pm._workspaceFolderIds["/repo/ws-1"]).toBe(folder.id);
    expect(notifyProjectsChanged).toHaveBeenCalledTimes(3);

    const unassigned = await call(
      route("POST", "/projects/:projectId/workspaces/folder"),
      d,
      { projectId: "p1" },
      { workspacePath: "/repo/ws-1", folderId: null },
    );
    expect(unassigned).toEqual({ status: 200, body: { ok: true } });
    expect(pm._workspaceFolderIds["/repo/ws-1"]).toBeNull();

    const deleted = await call(
      route("DELETE", "/projects/:projectId/folders/:folderId"),
      d,
      { projectId: "p1", folderId: folder.id },
    );
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect(notifyProjectsChanged).toHaveBeenCalledTimes(5);

    const listedAfterDelete = await call(
      route("GET", "/projects/:projectId/folders"),
      d,
      { projectId: "p1" },
    );
    expect(listedAfterDelete.body).toEqual([]);
  });

  it("404s create_folder against an unknown project", async () => {
    const d = deps(makeProjectManager());
    const res = await call(
      route("POST", "/projects/:projectId/folders"),
      d,
      { projectId: "no-such-project" },
      { name: "Anything" },
    );
    expect(res).toEqual({ status: 404, body: { error: "Project not found" } });
  });

  it("400s create_folder when 'name' is missing", async () => {
    const d = deps(makeProjectManager());
    const res = await call(
      route("POST", "/projects/:projectId/folders"),
      d,
      { projectId: "p1" },
      {},
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("name");
  });

  it("503s every route when project management is unavailable", async () => {
    const res = await call(
      route("GET", "/projects/:projectId/folders"),
      deps(null),
      { projectId: "p1" },
    );
    expect(res.status).toBe(503);
  });
});
