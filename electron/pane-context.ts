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
          return workspace.workspacePath as WorkspaceKey;
        }
      }
    }
  }
  return null;
}

/** The project+workspace whose workspace path best matches `somePath`, or null. */
export function matchProjectByPath(
  projects: ProjectInfo[],
  somePath: string,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null {
  let best: { project: ProjectInfo; workspace: WorkspaceInfo } | null = null;
  let bestLength = -1;

  for (const project of projects) {
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
