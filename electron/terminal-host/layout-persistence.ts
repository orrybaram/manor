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
// One layout model, shared with the renderer (ADR-179 D2). These are types
// only, so nothing from src/ lands in the terminal-host bundle — the same
// precedent as app-menu.ts importing src/lib/menu-commands.
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import type { PanelNode } from "../../src/lib/layout/panel-tree";


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

/** Persisted panel (v2 and v3) */
export interface PersistedPanel {
  id: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

/** V2 persisted workspace state (kept for migration) */
export interface PersistedWorkspaceV2 {
  workspacePath: string;
  panelTree: PanelNode;
  panels: Record<string, PersistedPanel>;
  activePanelId: string;
}

/** V2 full persisted layout (kept for migration) */
export interface PersistedLayoutV2 {
  version: 2;
  workspaces: PersistedWorkspaceV2[];
  lastActiveWorkspacePath?: string | null;
}

/**
 * What one renderer is *looking at* — which panel is active, which tab each
 * panel shows, which pane each tab focuses (ADR-179 D3).
 *
 * The file keeps exactly one of these per workspace: the **default viewport**,
 * handed to a renderer that has none of its own. A renderer's live viewport is
 * persisted per renderer (`viewport.json`, `localStorage`), not here.
 */
export interface PersistedDefaultViewport {
  activePanelId: string;
  /** panelId → tabId */
  selectedTabIds: Record<string, string>;
  /** tabId → paneId */
  focusedPaneIds: Record<string, string>;
}

/**
 * Persisted workspace state (v3).
 *
 * The focus fields still sit on the tree (`activePanelId`, `panels[].
 * selectedTabId`, `tabs[].focusedPaneId`) *and* in `defaultViewport`. That
 * duplication is deliberate and temporary: ADR-179 ticket 4 strips them from
 * the tree once every renderer reads its selection from the viewport slice.
 */
export interface PersistedWorkspace extends PersistedWorkspaceV2 {
  defaultViewport: PersistedDefaultViewport;
}

/** Full persisted layout (v3) */
export interface PersistedLayout {
  version: 3;
  workspaces: PersistedWorkspace[];
  /**
   * Path of the workspace/surface that was active when the layout was last
   * saved (includes the Home surface's `HOME_PATH`). Used to restore the last
   * surface on relaunch. Absent in layouts saved before this field existed.
   */
  lastActiveWorkspacePath?: string | null;
}

/** Migrate a v1 layout to v2 by wrapping each workspace's tabs in a single panel. */
function migrateV1toV2(v1: PersistedLayoutV1): PersistedLayoutV2 {
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

/**
 * Read a workspace's default viewport out of its tree (ADR-179 D3).
 *
 * This is the v2→v3 migration for one workspace and the normalizer for a
 * workspace saved through the renderer's old `layout:save` path, which is the
 * same operation: the fields are read, never moved, so running it twice is the
 * same as running it once and no tab can be lost by it.
 */
export function defaultViewportFromTree(
  workspace: PersistedWorkspaceV2,
): PersistedDefaultViewport {
  const selectedTabIds: Record<string, string> = {};
  const focusedPaneIds: Record<string, string> = {};
  for (const panel of Object.values(workspace.panels ?? {})) {
    if (panel.selectedTabId) selectedTabIds[panel.id] = panel.selectedTabId;
    for (const tab of panel.tabs) {
      if (tab.focusedPaneId) focusedPaneIds[tab.id] = tab.focusedPaneId;
    }
  }
  return {
    activePanelId: workspace.activePanelId,
    selectedTabIds,
    focusedPaneIds,
  };
}

/** A v2 workspace as v3: same tree, plus the viewport read out of it. */
export function migrateWorkspaceV2toV3(
  workspace: PersistedWorkspaceV2 | PersistedWorkspace,
): PersistedWorkspace {
  const existing = (workspace as PersistedWorkspace).defaultViewport;
  return {
    ...workspace,
    defaultViewport: existing ?? defaultViewportFromTree(workspace),
  };
}

function migrateV2toV3(v2: PersistedLayoutV2): PersistedLayout {
  return {
    ...v2,
    version: 3,
    workspaces: v2.workspaces.map(migrateWorkspaceV2toV3),
  };
}

export class LayoutPersistence {
  private filePath: string;
  /**
   * The file, in memory. `save` writes this whole object — there is one writer
   * (the Manor server's `LayoutStore`) and a read-modify-write per save was a
   * disk read on every debounce tick.
   */
  private current: PersistedLayout | null = null;

  constructor(filePath: string = LAYOUT_FILE) {
    this.filePath = filePath;
  }

  /** Save the full layout to disk */
  save(layout: PersistedLayout): void {
    this.current = layout;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(layout, null, 2));
  }

  /**
   * Load the layout from disk. Returns null if the file doesn't exist.
   * Migrates v1 → v2 → v3, and writes the migrated file back.
   */
  load(): PersistedLayout | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      if (!data.version || data.version === 1) {
        const migrated = migrateV2toV3(migrateV1toV2(data as PersistedLayoutV1));
        this.save(migrated);
        return migrated;
      }
      if (data.version === 2) {
        const migrated = migrateV2toV3(data as PersistedLayoutV2);
        this.save(migrated);
        return migrated;
      }
      // Already v3 — but a workspace written by the renderer's old path has no
      // `defaultViewport`, so normalize rather than trust the version alone.
      const layout = data as PersistedLayout;
      layout.workspaces = (layout.workspaces ?? []).map(migrateWorkspaceV2toV3);
      this.current = layout;
      return layout;
    } catch {
      return null;
    }
  }

  /**
   * Save a single workspace's layout (upsert by workspacePath).
   *
   * The renderer's old `layout:save` path, and only that — the Manor server
   * writes whole files through `save`. Deleted with the old path in ADR-179
   * ticket 3.
   */
  saveWorkspace(workspace: PersistedWorkspaceV2 | PersistedWorkspace): void {
    const layout = this.currentOrLoad() ?? { version: 3 as const, workspaces: [] };
    const next = migrateWorkspaceV2toV3(workspace);

    const idx = layout.workspaces.findIndex(
      (w) => w.workspacePath === next.workspacePath,
    );
    if (idx >= 0) {
      layout.workspaces[idx] = next;
    } else {
      layout.workspaces.push(next);
    }

    // The renderer only ever saves the currently-active workspace, so recording
    // its path here captures the last-active surface for relaunch restore.
    layout.lastActiveWorkspacePath = next.workspacePath;

    this.save(layout);
  }

  /** Remove a workspace's layout */
  removeWorkspace(workspacePath: string): void {
    const layout = this.currentOrLoad();
    if (!layout) return;

    layout.workspaces = layout.workspaces.filter(
      (w) => w.workspacePath !== workspacePath,
    );
    this.save(layout);
  }

  /** The in-memory file, reading it from disk the first time. */
  private currentOrLoad(): PersistedLayout | null {
    return this.current ?? this.load();
  }

  /**
   * Return the set of all daemonSessionIds referenced by any pane in the persisted layout.
   * Used to identify orphaned daemon sessions (alive in daemon but not in any pane).
   */
  getActiveSessionIds(): Set<string> {
    const layout = this.currentOrLoad();
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
    workspace: PersistedWorkspaceV2,
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
