/**
 * A pane's agent context — which project and workspace it is in — from the
 * server's own state (ADR-227 D5): the workspace whose layout holds the
 * pane, and the project that owns that workspace.
 *
 * What an agent started with no renderer is recorded under. A renderer's
 * `agents.setPaneContext` still overrides it (`serverAgentPipelineOptions`).
 * On a host server this is the only source: its projects and layout are its
 * own (ADR-227 D2).
 *
 * Electron-free: `createManorServer` composes it on both platforms.
 */

import type { PaneContext } from "../agent-status/effects";
import type { LayoutStore } from "../layout/layout-store";
import type { ProjectManager } from "../persistence";
import { parseWorkspaceKey } from "../../src/lib/workspace-key";

export function layoutPaneContext(
  layoutStore: Pick<LayoutStore, "workspaceOf">,
  projectManager: Pick<ProjectManager, "workspaceProject">,
  paneId: string,
): PaneContext | undefined {
  const key = layoutStore.workspaceOf(paneId);
  if (key === null) return undefined;
  const { hostId, path: workspacePath } = parseWorkspaceKey(key);
  const project = projectManager.workspaceProject(hostId, workspacePath);
  return project ? { ...project, workspacePath } : undefined;
}
