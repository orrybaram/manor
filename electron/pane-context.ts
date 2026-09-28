/**
 * Pure lookups for "which workspace/project is this MCP call running in".
 *
 * Everything is handed in as data — no Electron, no filesystem — so the
 * `GET /context` route (electron/routes/context.ts) can resolve a paneId →
 * workspace → project without this module ever touching disk or `electron`
 * itself.
 * Keeping it pure means it unit-tests without mocking anything.
 */

import * as path from "node:path";
import type { PersistedLayout } from "./terminal-host/layout-persistence";
import type { ProjectInfo, WorkspaceInfo } from "./persistence";
import { normalizeHostId } from "../src/lib/host-id";
import type { WorkspaceKey } from "../src/lib/workspace-key";

/**
 * The host-qualified key (ADR-191) of the workspace whose panes contain
 * `paneId`, or null.
 */
export function findWorkspaceForPane(
  layout: PersistedLayout,
  paneId: string,
): WorkspaceKey | null {
  for (const workspace of layout.workspaces ?? []) {
    const panels = workspace.panels ?? {};
    for (const panel of Object.values(panels)) {
      const tabs = panel?.tabs ?? [];
      for (const tab of tabs) {
        const paneSessions = tab?.paneSessions ?? {};
        if (paneId in paneSessions) {
          return workspace.workspacePath;
        }
      }
    }
  }
  return null;
}

/**
 * The project+workspace on `hostId` whose workspace path best matches
 * `somePath`, or null. A project lives on one host (ADR-178), so this
 * filters `projects` by `hostId` before matching the path — but it takes
 * the host as its own parameter, not a pre-filtered list, since a linked
 * project (#237 layer 2) will one day hold workspaces on more than one
 * host (ADR-191 §4).
 */
export function matchProjectByPath(
  projects: ProjectInfo[],
  hostId: string,
  somePath: string,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null {
  const wantHost = normalizeHostId(hostId);
  let best: { project: ProjectInfo; workspace: WorkspaceInfo } | null = null;
  let bestLength = -1;

  for (const project of projects) {
    if (normalizeHostId(project.hostId) !== wantHost) continue;

    for (const workspace of project.workspaces ?? []) {
      const p = workspace.path;
      if (!p) continue;

      if (p === somePath) {
        return { project, workspace };
      }

      if (somePath.startsWith(p + path.sep) && p.length > bestLength) {
        best = { project, workspace };
        bestLength = p.length;
      }
    }
  }

  return best;
}
