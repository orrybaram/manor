/**
 * `GET /context?paneId=…&cwd=…` — "which project is calling me?".
 *
 * A three-rung ladder: the caller's pane id, then its cwd, then a 404 carrying
 * the candidate list so the model can retry with an explicit `projectId`.
 *
 * Every caller has a host: the host that
 * owns the calling pane (`SessionOwners`, keyed by pane id — a pane moved
 * to another host still answers to its session owner), else local.
 * That host's projects are the only candidates on rungs 2 and 3 — a project
 * on another host at the same path must not win, and the 404's list must
 * not offer a retry the relay would refuse anyway. Rung 1 needs no such
 * guess: the layout (the Manor server's) keys each workspace by its
 * host-qualified `WorkspaceKey` (#240), so the pane's workspace host is read
 * straight off that key — the workspace the pane lives in, even when
 * its session has moved to another host. `SessionOwners` only
 * stands in when the layout has no record of the pane.
 */

import type { ProjectInfo, WorkspaceInfo } from "../persistence";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LayoutStore } from "../layout/layout-store";
import { findWorkspaceForPane, matchProjectByPath } from "../pane-context";
import { findPanelWithPane } from "../../src/lib/layout/workspace-layout";
import {
  LOCAL_HOST_ID,
  normalizeHostId,
  parseWorkspaceKey,
  type WorkspaceKey,
} from "../../src/lib/workspace-key";
import { availableSources } from "../issue-backends";
import type { ServerRoute } from "./types";

/**
 * Rung 1: the pane id is authoritative — it names the *caller's* pane, not
 * whatever the user happens to be looking at. A pane the layout does not
 * hold (a mini terminal, a pane closed a moment ago) must fall through to
 * cwd, never 404 here; so must a corrupt or half-written `layout.json`, when
 * there is no layout store to ask.
 *
 * The workspace key names its own host, so it — not the caller's guessed
 * host — is what `matchProjectByPath` matches against: a pane recorded on
 * "box" resolves against "box"'s projects even if the caller somehow looked
 * local.
 */
function resolveByPane(
  layout: { store: LayoutStore | null; persistence: LayoutPersistence | null },
  projects: ProjectInfo[],
  paneId: string | null,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null {
  if (!paneId) return null;
  const key = workspaceOfPane(layout, paneId);
  if (!key) return null;
  const { hostId, path } = parseWorkspaceKey(key);
  return matchProjectByPath(projects, hostId, path);
}

/**
 * The key of the workspace whose tree holds `paneId`. The Manor server's
 * layout store is the authority and holds every pane the moment
 * it exists; the file it writes on a debounce is the fallback for a server
 * built without one.
 */
function workspaceOfPane(
  layout: { store: LayoutStore | null; persistence: LayoutPersistence | null },
  paneId: string,
): WorkspaceKey | null {
  if (layout.store) {
    for (const [key, entry] of Object.entries(layout.store.getAll())) {
      if (findPanelWithPane(entry.layout, paneId)) return key as WorkspaceKey;
    }
    return null;
  }
  const file = layout.persistence?.load() ?? null;
  return file ? findWorkspaceForPane(file, paneId) : null;
}

export const contextRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/context",
    async handler({ deps, url, json }) {
      const paneId = url.searchParams.get("paneId");
      const cwd = url.searchParams.get("cwd");
      const projects = await deps.projectManager.getProjects();

      const callerHost =
        (paneId ? deps.sessionOwners.ownerOf(paneId) : undefined) ??
        LOCAL_HOST_ID;

      // Exact-host filter: a local caller is scoped to its own host too.
      const candidates = projects.filter(
        (p) => normalizeHostId(p.hostId) === callerHost,
      );
      const resolved =
        resolveByPane(
          { store: deps.layoutStore, persistence: deps.layoutPersistence },
          projects,
          paneId,
        ) ??
        (cwd ? matchProjectByPath(projects, callerHost, cwd) : null);

      // Rung 3: hand back the candidate list so the model can retry explicitly.
      if (!resolved) {
        json(404, {
          error:
            "Could not determine the current project. Pass projectId explicitly.",
          candidates: candidates.map((p) => ({
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
