/**
 * `GET /context?paneId=…&cwd=…` — "which project is calling me?" (ADR-150).
 *
 * A three-rung ladder: the caller's pane id, then its cwd, then a 404 carrying
 * the candidate list so the model can retry with an explicit `projectId`.
 *
 * Every caller has a host (ADR-191 §4): `deps.callerHostId` for a request
 * relayed from a remote host's `manor` CLI (ADR-189 §2), else the host that
 * owns the calling pane (`SessionOwners`, keyed by pane id — a pane ADR-183
 * moved to another host still answers to its session owner), else local.
 * That host's projects are the only candidates on rungs 2 and 3 — a project
 * on another host at the same path must not win, and the 404's list must
 * not offer a retry the relay would refuse anyway. Rung 1 needs no such
 * guess: the layout (the Manor server's, ADR-179) keys each workspace by its
 * host-qualified `WorkspaceKey` (ADR-191, #240), so the pane's workspace host is read
 * straight off that key — the workspace the pane lives in, even when
 * ADR-183 has moved its session to another host. `SessionOwners` only
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
import { callerMaySee } from "./caller-host";
import type { Route } from "./types";

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
 * local. A relayed caller still only ever sees its own host's panes.
 */
function resolveByPane(
  layout: { store: LayoutStore | null; persistence: LayoutPersistence | null },
  projects: ProjectInfo[],
  paneId: string | null,
  relayedFrom: string | undefined,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null {
  if (!paneId) return null;
  const key = workspaceOfPane(layout, paneId);
  if (!key) return null;
  const { hostId, path } = parseWorkspaceKey(key);
  // A relayed caller sees only its own host (ADR-189 §2): naming another
  // host's pane id must not hand it that host's project.
  if (!callerMaySee(relayedFrom, normalizeHostId(hostId))) return null;
  return matchProjectByPath(projects, hostId, path);
}

/**
 * The key of the workspace whose tree holds `paneId`. The Manor server's
 * layout store is the authority (ADR-179 D1) and holds every pane the moment
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

      const callerHostId =
        deps.callerHostId ??
        (paneId ? deps.sessionOwners?.ownerOf(paneId) : undefined) ??
        LOCAL_HOST_ID;

      // `callerHostId` here is always resolved (never undefined), so this
      // is an exact-host filter, not `callerMaySee`'s "a local caller sees
      // everything" — a local caller here is scoped to its own host too.
      const candidates = projects.filter((p) =>
        callerMaySee(callerHostId, normalizeHostId(p.hostId)),
      );
      const resolved =
        resolveByPane(
          { store: deps.layoutStore ?? null, persistence: deps.layoutPersistence },
          projects,
          paneId,
          deps.callerHostId,
        ) ??
        (cwd ? matchProjectByPath(projects, callerHostId, cwd) : null);

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
