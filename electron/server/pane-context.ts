/**
 * A pane's agent context — which project and workspace it is in — from the
 * server's own state (ADR-227 D5): the workspace whose layout holds the
 * pane, and the project that owns that workspace.
 *
 * What an agent started with no renderer is recorded under. A renderer's
 * `agents.setPaneContext` still overrides it (`serverAgentPipelineOptions`),
 * and the host server falls back to its owner's manifest for a pane its own
 * layout does not hold.
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
