/**
 * Layout persistence — saves/loads pane tree + session mapping to disk.
 *
 * Persists workspace session layout (pane trees, focused pane, titles)
 * along with the mapping from pane IDs to daemon session IDs.
 *
 * Stored in ~/.manor/layout.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { layoutFile } from "../paths";
/**
 * Duplicated from src/store/pane-tree.ts — the terminal-host is a separate
 * Vite entry point and cannot import from the renderer bundle.
 */
type PaneNode =
  | { type: "leaf"; paneId: string; contentType?: "terminal" | "browser" | "diff"; url?: string }
  | { type: "split"; direction: "horizontal" | "vertical"; ratio: number; first: PaneNode; second: PaneNode };

/**
 * Duplicated from src/store/panel-tree.ts — same reason as PaneNode above.
 */
type PanelNode =
  | { type: "leaf"; panelId: string }
  | { type: "split"; direction: "horizontal" | "vertical"; ratio: number; first: PanelNode; second: PanelNode };

function allPaneIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...allPaneIds(node.first), ...allPaneIds(node.second)];
}

type LeafInfo = { paneId: string; contentType?: string };

/** Collect paneId and contentType for every leaf in the tree. */
function allLeaves(node: PaneNode): LeafInfo[] {
  if (node.type === "leaf") return [{ paneId: node.paneId, contentType: node.contentType }];
  return [...allLeaves(node.first), ...allLeaves(node.second)];
}

export const LAYOUT_FILE = layoutFile();

/** Agent state snapshot for persistence */
export interface PersistedAgentState {
  kind: string | null;
  status: string;
  processName: string | null;
  since: number;
  title: string | null;
}

/** Persisted pane → daemon session mapping */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
  lastTitle: string | null;
  lastAgentStatus?: PersistedAgentState | null;
}

/** Persisted tab layout */
export interface PersistedTab {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
  paneSessions: Record<string, PersistedPaneSession>;
}

/** V1 persisted workspace state (kept for migration) */
export interface PersistedWorkspaceV1 {
  workspacePath: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds?: string[];
}

/** V1 full persisted layout (kept for migration) */
export interface PersistedLayoutV1 {
  version: 1;
  workspaces: PersistedWorkspaceV1[];
}

/** Persisted panel (v2) */
export interface PersistedPanel {
  id: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

/** Persisted workspace state (v2) */
export interface PersistedWorkspace {
  workspacePath: string;
  panelTree: PanelNode;
  panels: Record<string, PersistedPanel>;
  activePanelId: string;
}

/** Full persisted layout (v2) */
export interface PersistedLayout {
  version: 2;
  workspaces: PersistedWorkspace[];
}

/** Migrate a v1 layout to v2 by wrapping each workspace's tabs in a single panel. */
function migrateV1toV2(v1: PersistedLayoutV1): PersistedLayout {
  return {
    version: 2,
    workspaces: v1.workspaces.map((ws) => {
      const panelId = `panel-${crypto.randomUUID()}`;
      return {
        workspacePath: ws.workspacePath,
        panelTree: { type: "leaf" as const, panelId },
        panels: {
          [panelId]: {
            id: panelId,
            tabs: ws.tabs,
            selectedTabId: ws.selectedTabId,
            pinnedTabIds: ws.pinnedTabIds ?? [],
          },
        },
        activePanelId: panelId,
      };
    }),
  };
}

export class LayoutPersistence {
  private filePath: string;

  constructor(filePath: string = LAYOUT_FILE) {
    this.filePath = filePath;
  }

  /** Save the full layout to disk */
  save(layout: PersistedLayout): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(layout, null, 2));
  }

  /** Load the layout from disk. Returns null if file doesn't exist. Migrates v1 to v2. */
  load(): PersistedLayout | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      // Migrate v1 -> v2 if needed
      if (!data.version || data.version === 1) {
        const migrated = migrateV1toV2(data as PersistedLayoutV1);
        // Save migrated format back to disk
        this.save(migrated);
        return migrated;
      }
      return data as PersistedLayout;
    } catch {
      return null;
    }
  }

  /** Save a single workspace's layout (upsert by workspacePath) */
  saveWorkspace(workspace: PersistedWorkspace): void {
    let layout = this.load();
    if (!layout) {
      layout = { version: 2, workspaces: [] };
    }

    const idx = layout.workspaces.findIndex(
      (w) => w.workspacePath === workspace.workspacePath,
    );
    if (idx >= 0) {
      layout.workspaces[idx] = workspace;
    } else {
      layout.workspaces.push(workspace);
    }

    this.save(layout);
  }

  /** Remove a workspace's layout */
  removeWorkspace(workspacePath: string): void {
    const layout = this.load();
    if (!layout) return;

    layout.workspaces = layout.workspaces.filter(
      (w) => w.workspacePath !== workspacePath,
    );
    this.save(layout);
  }

  /**
   * Return the set of all daemonSessionIds referenced by any pane in the persisted layout.
   * Used to identify orphaned daemon sessions (alive in daemon but not in any pane).
   */
  getActiveSessionIds(): Set<string> {
    const layout = this.load();
    const ids = new Set<string>();
    if (!layout) return ids;
    for (const workspace of layout.workspaces) {
      for (const panel of Object.values(workspace.panels)) {
        for (const tab of panel.tabs) {
          for (const paneSession of Object.values(tab.paneSessions)) {
            ids.add(paneSession.daemonSessionId);
          }
        }
      }
    }
    return ids;
  }

  /**
   * Reconcile persisted layout against running daemon sessions.
   *
   * For each pane in the persisted layout:
   * - If daemon has the session → warm restore
   * - If daemon lost it but scrollback exists → cold restore
   * - If neither → fresh session
   */
  reconcile(
    workspace: PersistedWorkspace,
    aliveDaemonSessionIds: Set<string>,
    persistedSessionIds: Set<string>,
  ): ReconciliationPlan {
    const actions: PaneRestoreAction[] = [];

    for (const panel of Object.values(workspace.panels)) {
      for (const tab of panel.tabs) {
        for (const { paneId, contentType } of allLeaves(tab.rootNode)) {
          // Non-terminal panes (diff, browser, etc.) don't have daemon sessions —
          // they are restored from the pane tree's contentType alone.
          if (contentType && contentType !== "terminal") {
            continue;
          }

          const paneSession = tab.paneSessions[paneId];
          if (!paneSession) {
            actions.push({ type: "fresh", paneId, cwd: null });
            continue;
          }

          const { daemonSessionId, lastCwd } = paneSession;

          if (aliveDaemonSessionIds.has(daemonSessionId)) {
            actions.push({ type: "warm", paneId, daemonSessionId });
          } else if (persistedSessionIds.has(daemonSessionId)) {
            actions.push({ type: "cold", paneId, daemonSessionId, lastCwd });
          } else {
            actions.push({ type: "fresh", paneId, cwd: lastCwd });
          }
        }
      }
    }

    return { actions };
  }
}

export type PaneRestoreAction =
  | { type: "warm"; paneId: string; daemonSessionId: string }
  | {
      type: "cold";
      paneId: string;
      daemonSessionId: string;
      lastCwd: string | null;
    }
  | { type: "fresh"; paneId: string; cwd: string | null };

export interface ReconciliationPlan {
  actions: PaneRestoreAction[];
}
