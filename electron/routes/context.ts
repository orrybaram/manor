/**
 * `GET /context?paneId=…&cwd=…` — "which project is calling me?" (ADR-150).
 *
 * A three-rung ladder: the caller's pane id, then its cwd, then a 404 carrying
 * the candidate list so the model can retry with an explicit `projectId`.
 */

import type { ProjectInfo, WorkspaceInfo } from "../persistence";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import { findWorkspaceForPane, matchProjectByPath } from "../pane-context";
import { availableSources } from "../issue-backends";
import type { Route } from "./types";

/**
 * Rung 1: the pane id is authoritative — it names the *caller's* pane, not
 * whatever the user happens to be looking at. But `layout.json` is written
 * on a 500ms debounce and serializes only the active workspace, so a pane
 * legitimately missing from it must fall through to cwd, never 404 here.
 * A corrupt or half-written file is the same fall-through, not a 500.
 */
function resolveByPane(
  layoutPersistence: LayoutPersistence | null,
  projects: ProjectInfo[],
  paneId: string | null,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null {
  if (!paneId) return null;
  const layout = layoutPersistence?.load() ?? null;
  const workspacePath = layout ? findWorkspaceForPane(layout, paneId) : null;
  if (!workspacePath) return null;
  const match = matchProjectByPath(projects, workspacePath);
  if (!match) return null;
  return match;
}

export const contextRoutes: Route[] = [
  {
    method: "GET",
    path: "/context",
    async handler({ deps, url, json }) {
      const pm = deps.projectManager;
      if (!pm) {
        json(503, { error: "Project management is not available" });
        return;
      }
      const paneId = url.searchParams.get("paneId");
      const cwd = url.searchParams.get("cwd");
      const projects = await pm.getProjects();

      const resolved =
        resolveByPane(deps.layoutPersistence, projects, paneId) ??
        (cwd ? matchProjectByPath(projects, cwd) : null);

      // Rung 3: hand back the candidate list so the model can retry explicitly.
      if (!resolved) {
        json(404, {
          error:
            "Could not determine the current project. Pass projectId explicitly.",
          candidates: projects.map((p) => ({
            projectId: p.id,
            name: p.name,
            path: p.path,
          })),
        });
        return;
      }

      const sources = await availableSources(deps, resolved.project);

      json(200, {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        projectPath: resolved.project.path,
        workspacePath: resolved.workspace.path,
        branch: resolved.workspace.branch,
        isMain: resolved.workspace.isMain,
        sources,
      });
    },
  },
];
