/**
 * `/projects/:projectId/folders` — sidebar folder CRUD (ADR-167, nested by
 * ADR-172) — and the
 * `/workspaces/folder` route that assigns a workspace into one. Every handler
 * is a direct `ProjectManager` call; `withProject` (from `./projects`) supplies
 * the 503/404 preamble every route here shares with the other project routes.
 */

import { notifyProjectsChanged } from "../renderer-bridge";
import { requireFolder, requireWorkspace, withProject } from "./projects";
import type { Route } from "./types";

export const folderRoutes: Route[] = [
  {
    method: "GET",
    path: "/projects/:projectId/folders",
    handler: withProject(async ({ json }, _pm, project) => {
      json(200, project.folders);
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/folders",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const name = body.name;
      if (typeof name !== "string" || !name.trim()) {
        json(400, { error: "Missing 'name' string in request body" });
        return;
      }
      const parentId = body.parentId ?? null;
      if (parentId !== null && typeof parentId !== "string") {
        json(400, { error: "'parentId' must be a string or null" });
        return;
      }
      const folder = pm.createWorkspaceFolder(params.projectId, name, parentId);
      if (!folder) {
        json(500, { error: "Failed to create folder" });
        return;
      }
      notifyProjectsChanged();
      json(200, folder);
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/folders/:folderId/rename",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const name = body.name;
      if (typeof name !== "string" || !name.trim()) {
        json(400, { error: "Missing 'name' string in request body" });
        return;
      }
      if (!requireFolder(project, params.folderId, json)) return;
      pm.renameWorkspaceFolder(params.projectId, params.folderId, name);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/folders/:folderId/parent",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const parentId = body.parentId ?? null;
      if (parentId !== null && typeof parentId !== "string") {
        json(400, { error: "'parentId' must be a string or null" });
        return;
      }
      if (!requireFolder(project, params.folderId, json)) return;
      if (parentId !== null && !requireFolder(project, parentId, json)) return;
      // Main refuses a parent that is the folder itself or one of its own
      // descendants; that is a conflict with the tree, not a bad request.
      if (!pm.setFolderParent(params.projectId, params.folderId, parentId)) {
        json(409, { error: "Would create a folder cycle" });
        return;
      }
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "DELETE",
    path: "/projects/:projectId/folders/:folderId",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      await readBody();
      if (!requireFolder(project, params.folderId, json)) return;
      pm.deleteWorkspaceFolder(params.projectId, params.folderId);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/folder",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      const folderId = body.folderId;
      if (folderId !== null && typeof folderId !== "string") {
        json(400, { error: "'folderId' must be a string or null" });
        return;
      }
      if (!requireWorkspace(project, workspacePath, json)) return;
      if (folderId !== null && !requireFolder(project, folderId, json)) return;
      pm.setWorkspaceFolder(params.projectId, workspacePath, folderId);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },
];
