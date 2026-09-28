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
import {
  isRemoteWorkspaceKey,
  migrateWorkspaceKey,
  type WorkspaceKey,
  type WorkspaceKeyOwner,
} from "../../src/lib/workspace-key";
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

/** Persisted workspace state (v2 and v3) */
export interface PersistedWorkspace {
  /**
   * The workspace's host-qualified key (`WorkspaceKey`, ADR-191) since
   * version 3: its bare path on this machine, `<hostId>:<path>` on a remote
   * host. A bare path in a version 2 file is of unknown host until
   * `migrateWorkspaceKeys` runs. The field keeps its name so a downgrade
   * still finds every local workspace.
   */
  workspacePath: WorkspaceKey;
  panelTree: PanelNode;
  panels: Record<string, PersistedPanel>;
  activePanelId: string;
}

/**
 * The current layout file version. Version 3 keys workspaces by host-qualified
 * workspace key (ADR-191); version 2 keyed them by bare path.
 */
export const LAYOUT_VERSION = 3;

/** Full persisted layout (v2 and v3) */
export interface PersistedLayout {
  /** 2 until `migrateWorkspaceKeys` has run on the file, then 3. */
  version: 2 | 3;
  workspaces: PersistedWorkspace[];
  /**
   * Key of the workspace/surface that was active when the layout was last
   * saved (includes the Home surface's `HOME_PATH`). Used to restore the last
   * surface on relaunch. Absent in layouts saved before this field existed.
   * A workspace key since version 3, like `PersistedWorkspace.workspacePath`.
   */
  lastActiveWorkspacePath?: string | null;
}

/** Migrate a v1 layout to v2 by wrapping each workspace's tabs in a single panel. */
function migrateV1toV2(v1: PersistedLayoutV1): PersistedLayout {
  return {
    version: 2,
    workspaces: v1.workspaces.map((ws) => {
      const panelId = `panel-${crypto.randomUUID()}`;
      return {
        // A bare path: a legacy key, until `migrateWorkspaceKeys` runs.
        workspacePath: ws.workspacePath as WorkspaceKey,
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
 * `layout` with every workspace rekeyed from its bare path to its
 * host-qualified key (version 2 → 3, ADR-191).
 *
 * While the file was at version 2 the renderer wrote a local workspace under
 * its bare path and a remote one under its qualified key (the local key *is*
 * the bare path). So a bare entry is migrated to the host of the project that
 * owns it — local when none does or on a tie — except when the file already
 * holds a qualified entry for that very workspace: then that host has its own
 * layout, and the bare entry stays where it is, as local. No two entries ever
 * land on one key, so nothing is dropped.
 */
export function migrateLayoutV2toV3(
  layout: PersistedLayout,
  owners: readonly WorkspaceKeyOwner[],
): PersistedLayout {
  const qualified = new Set(
    layout.workspaces.map((ws) => ws.workspacePath).filter(isRemoteWorkspaceKey),
  );
  const migrate = (key: string): WorkspaceKey => {
    const migrated = migrateWorkspaceKey(key, owners);
    return migrated !== key && qualified.has(migrated) ? (key as WorkspaceKey) : migrated;
  };
  const last = layout.lastActiveWorkspacePath;
  return {
    ...layout,
    version: LAYOUT_VERSION,
    workspaces: layout.workspaces.map((ws) => ({ ...ws, workspacePath: migrate(ws.workspacePath) })),
    ...(last ? { lastActiveWorkspacePath: migrate(last) } : {}),
  };
}

export class LayoutPersistence {
  private filePath: string;
  private ready: Promise<void> = Promise.resolve();

  constructor(filePath: string = LAYOUT_FILE) {
    this.filePath = filePath;
  }

  /**
   * Run the one-time version 2 → 3 workspace-key migration in the
   * background, asking `owners` for the projects only when the file needs
   * it. `whenReady` resolves once it is done. When `owners` can't tell every
   * path's host (null: a remote host did not answer) or fails, the file stays
   * at version 2 to try again next launch: a guess written as version 3
   * could never be corrected.
   */
  startWorkspaceKeyMigration(
    owners: () => Promise<readonly WorkspaceKeyOwner[] | null>,
  ): Promise<void> {
    this.ready = (async () => {
      if (!this.needsWorkspaceKeyMigration()) return;
      const known = await owners();
      if (!known) {
        console.warn("[layout] a host did not answer; workspace-key migration retries next launch");
        return;
      }
      this.migrateWorkspaceKeys(known);
    })().catch((err: unknown) => {
      console.error("[layout] workspace-key migration failed:", err);
    });
    return this.ready;
  }

  /** Resolves once `startWorkspaceKeyMigration`'s run, if any, has finished. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Whether the file on disk is keyed by bare path (version 2 or older). */
  needsWorkspaceKeyMigration(): boolean {
    const layout = this.load();
    return layout !== null && layout.version < LAYOUT_VERSION;
  }

  /**
   * Rekey a version 2 file by host-qualified workspace key and write it as
   * version 3. A no-op at version 3: a bare key there already means local,
   * and migrating it again could move it to a remote project with the same
   * path (ADR-191 §1).
   */
  migrateWorkspaceKeys(owners: readonly WorkspaceKeyOwner[]): void {
    const layout = this.load();
    if (!layout || layout.version >= LAYOUT_VERSION) return;
    this.save(migrateLayoutV2toV3(layout, owners));
  }

  /**
   * Move each `[from, to]` workspace key's layout to `to` — a project moved
   * to another host keeps its workspaces' layouts (ADR-191 §3). The renderer
   * makes the same moves in `closeWorkspacesLeftBehind`. A `to` that
   * already has a layout keeps it, and `from` is then left in place. See
   * `migrateLayoutV2toV3` for how a file not yet migrated is keyed.
   */
  moveWorkspaces(moves: ReadonlyArray<readonly [WorkspaceKey, WorkspaceKey]>): void {
    const layout = this.load();
    if (!layout) return;
    const migrated = layout.version >= LAYOUT_VERSION;
    let changed = false;
    for (const [from, to] of moves) {
      if (from === to) continue;
      // A bare entry in a file not yet migrated is left for the migration,
      // which gives it to whichever host owns the path then: the moved
      // project's new one. A qualified entry is already a real key.
      if (!migrated && !isRemoteWorkspaceKey(from)) continue;
      if (layout.workspaces.some((w) => w.workspacePath === to)) continue;
      const ws = layout.workspaces.find((w) => w.workspacePath === from);
      if (!ws) continue;
      ws.workspacePath = to;
      if (layout.lastActiveWorkspacePath === from) layout.lastActiveWorkspacePath = to;
      changed = true;
    }
    if (changed) this.save(layout);
  }

  /** Save the full layout to disk */
  save(layout: PersistedLayout): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(layout, null, 2));
  }

  /**
   * Load the layout from disk. Returns null if file doesn't exist. Migrates
   * v1 to v2; v2 to v3 needs the projects, so it is `migrateWorkspaceKeys`.
   */
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

  /**
   * Save a single workspace's layout (upsert by its workspace key). A file
   * still at version 2 keeps that version, so its migration still runs.
   */
  saveWorkspace(workspace: PersistedWorkspace): void {
    let layout = this.load();
    if (!layout) {
      layout = { version: LAYOUT_VERSION, workspaces: [] };
    }

    const idx = layout.workspaces.findIndex(
      (w) => w.workspacePath === workspace.workspacePath,
    );
    if (idx >= 0) {
      layout.workspaces[idx] = workspace;
    } else {
      layout.workspaces.push(workspace);
    }

    // The renderer only ever saves the currently-active workspace, so recording
    // its key here captures the last-active surface for relaunch restore.
    layout.lastActiveWorkspacePath = workspace.workspacePath;

    this.save(layout);
  }

  /** Remove a workspace's layout, by its workspace key */
  removeWorkspace(key: WorkspaceKey): void {
    const layout = this.load();
    if (!layout) return;

    layout.workspaces = layout.workspaces.filter(
      (w) => w.workspacePath !== key,
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
