/**
 * Layout persistence — `~/.manor/layout.json`, read and written whole.
 *
 * The file holds every workspace's pane tree, its per-pane daemon session
 * mapping and its default viewport, plus the migrations that bring an older
 * file up to the current version. The one writer is the Manor server's
 * `LayoutStore` (ADR-179 D1); this class knows nothing about commands or
 * renderers.
 *
 * Versions:
 * - 1: one tab list per workspace.
 * - 2: panels; workspaces keyed by bare path; focus fields in the tree.
 * - 3: workspaces keyed by host-qualified `WorkspaceKey` (ADR-191).
 * - 4: the focus fields leave the tree for a per-workspace `defaultViewport`
 *   (ADR-179 D3).
 *
 * The key migration (→ 3) needs the projects and so runs in the background
 * (`startWorkspaceKeyMigration`); the viewport migration (→ 4) needs nothing
 * and runs on every load. A file the key migration has not reached yet keeps
 * `version: 2` — with its viewport already split out — so the key migration
 * still finds it next launch.
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
import { isHomePath } from "../../src/lib/home-path";
// One layout model, shared with the renderer (ADR-179 D2). These are types
// only, so nothing from src/ lands in the terminal-host bundle — the same
// precedent as app-menu.ts importing src/lib/menu-commands.
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import type { PanelNode } from "../../src/lib/layout/panel-tree";
import type {
  PersistedDefaultViewport,
  PersistedPaneSession,
} from "../../src/lib/layout/protocol";

export type {
  PersistedAgentState,
  PersistedDefaultViewport,
  PersistedPaneSession,
} from "../../src/lib/layout/protocol";

export const LAYOUT_FILE = layoutFile();

/**
 * Persisted tab layout.
 *
 * `focusedPaneId` is optional and, as of ADR-179 ticket 4, never written: it
 * is viewport, it lives in `defaultViewport` and in each renderer's own file,
 * and it survives in this type only so an older file can be read and
 * migrated.
 */
export interface PersistedTab {
  id: string;
  title: string;
  rootNode: PaneNode;
  /** @deprecated read-only, for migration — see above. */
  focusedPaneId?: string;
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

/**
 * Persisted panel (v2 and v3). `selectedTabId` is viewport: migration only.
 *
 * `pinnedTabIds` is required here and on `Panel`: every load path fills it
 * (`migrateV1toV2`, `withoutTreeFocus`), so nothing downstream of the file
 * ever sees a panel without one.
 */
export interface PersistedPanel {
  id: string;
  tabs: PersistedTab[];
  /** @deprecated read-only, for migration — see {@link PersistedTab}. */
  selectedTabId?: string;
  pinnedTabIds: string[];
}

/** V2/v3 persisted workspace state: focus still in the tree (migration only) */
export interface PersistedWorkspaceV2 {
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
  /** @deprecated read-only, for migration — see {@link PersistedTab}. */
  activePanelId?: string;
}

/** V2 full persisted layout (kept for migration) */
export interface PersistedLayoutV2 {
  version: 2;
  workspaces: PersistedWorkspaceV2[];
  lastActiveWorkspacePath?: string | null;
}

/**
 * Persisted workspace state (v3).
 *
 * Structure plus one **default viewport** — and nothing else. The focus
 * fields left the tree in ADR-179 ticket 4; an older file still carries them,
 * still loads (they are optional), and is rewritten clean the first time the
 * server saves.
 */
export interface PersistedWorkspace extends PersistedWorkspaceV2 {
  defaultViewport: PersistedDefaultViewport;
}

/**
 * The current layout file version: workspaces keyed by `WorkspaceKey`
 * (version 3, ADR-191) and the focus fields out of the tree (version 4,
 * ADR-179 D3).
 */
export const LAYOUT_VERSION = 4;

/** The first version whose workspaces are keyed by `WorkspaceKey` (ADR-191). */
export const KEYED_LAYOUT_VERSION = 3;

/** Full persisted layout */
export interface PersistedLayout {
  /**
   * 2 until `migrateWorkspaceKeys` has run on the file (its workspaces are
   * bare paths), then {@link LAYOUT_VERSION}. A version 3 file — keyed, focus
   * still in the tree — becomes version 4 the first time it is loaded.
   */
  version: 2 | 3 | 4;
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
function migrateV1toV2(v1: PersistedLayoutV1): PersistedLayoutV2 {
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

/** A workspace with the focus fields stripped from its tree (ticket 4). */
function withoutTreeFocus(workspace: PersistedWorkspace): PersistedWorkspace {
  const panels: Record<string, PersistedPanel> = {};
  for (const [panelId, panel] of Object.entries(workspace.panels ?? {})) {
    panels[panelId] = {
      id: panel.id,
      tabs: panel.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        rootNode: tab.rootNode,
        paneSessions: tab.paneSessions ?? {},
      })),
      pinnedTabIds: panel.pinnedTabIds ?? [],
    };
  }
  return {
    workspacePath: workspace.workspacePath,
    panelTree: workspace.panelTree,
    panels,
    defaultViewport: workspace.defaultViewport,
  };
}

/**
 * Read a workspace's default viewport out of its tree (ADR-179 D3).
 *
 * This is the viewport migration for one workspace and the normalizer for a
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
    activePanelId: workspace.activePanelId ?? null,
    selectedTabIds,
    focusedPaneIds,
  };
}

/** A workspace with focus in its tree, as one with a default viewport. */
export function migrateWorkspaceViewport(
  workspace: PersistedWorkspaceV2 | PersistedWorkspace,
): PersistedWorkspace {
  const existing = (workspace as PersistedWorkspace).defaultViewport;
  return withoutTreeFocus({
    ...workspace,
    defaultViewport: existing ?? defaultViewportFromTree(workspace),
  });
}

/**
 * `layout` with every workspace rekeyed from its bare path to its
 * host-qualified key (version 2 → 3, ADR-191), written at the current version.
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

/**
 * The version a file on disk is *really* at, as far as its keys go.
 *
 * Builds of the ADR-179 branch cut before ADR-191 wrote `version: 3` with a
 * `defaultViewport` per workspace and bare-path keys. A real version 3 file
 * (ADR-191) never has a `defaultViewport`, so such a file is read as the
 * version 2 it is keyed like, and its key migration still runs.
 */
function keyVersionOf(data: {
  version: number;
  workspaces?: Array<Partial<PersistedWorkspace>>;
}): 2 | 3 | 4 {
  if (data.version >= LAYOUT_VERSION) return LAYOUT_VERSION;
  if (data.version === KEYED_LAYOUT_VERSION) {
    const preKeyed = (data.workspaces ?? []).some((ws) => ws.defaultViewport);
    return preKeyed ? 2 : 3;
  }
  return 2;
}

export class LayoutPersistence {
  private filePath: string;
  private ready: Promise<void> = Promise.resolve();
  /**
   * The file, in memory. `save` writes this whole object — there is one writer
   * (the Manor server's `LayoutStore`) and a read-modify-write per save was a
   * disk read on every debounce tick.
   */
  private current: PersistedLayout | null = null;

  constructor(filePath: string = LAYOUT_FILE) {
    this.filePath = filePath;
  }

  /**
   * Run the one-time version 2 → 3 workspace-key migration in the
   * background, asking `owners` for the projects only when the file needs
   * it. `whenReady` resolves once it is done. When `owners` can't tell every
   * path's host (null: a remote host did not answer) or fails, the file stays
   * at version 2 to try again next launch: a guess written as keyed could
   * never be corrected.
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
    return layout !== null && layout.version < KEYED_LAYOUT_VERSION;
  }

  /**
   * Rekey a version 2 file by host-qualified workspace key and write it at
   * the current version. A no-op once keyed: a bare key there already means
   * local, and migrating it again could move it to a remote project with the
   * same path (ADR-191 §1).
   */
  migrateWorkspaceKeys(owners: readonly WorkspaceKeyOwner[]): void {
    const layout = this.load();
    if (!layout || layout.version >= KEYED_LAYOUT_VERSION) return;
    this.save(migrateLayoutV2toV3(layout, owners));
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
   *
   * Every workspace comes back with its viewport out of the tree (ADR-179
   * D3), whatever the file's version: the split is idempotent and needs
   * nothing. The key migration needs the projects, so it is
   * `migrateWorkspaceKeys`; until it has run the layout says `version: 2`.
   * A file this changes — a new version, or a viewport split out — is
   * written back.
   */
  load(): PersistedLayout | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      const v2 =
        !data.version || data.version === 1
          ? migrateV1toV2(data as PersistedLayoutV1)
          : null;
      const source = (v2 ?? data) as {
        version: number;
        workspaces?: PersistedWorkspaceV2[];
        lastActiveWorkspacePath?: string | null;
      };
      const version = keyVersionOf(source);
      const layout: PersistedLayout = {
        ...source,
        // A keyed file is brought to the current version here; a bare-path
        // one waits for its key migration.
        version: version === 2 ? 2 : LAYOUT_VERSION,
        workspaces: (source.workspaces ?? []).map(migrateWorkspaceViewport),
      };
      // Written back whenever the read changed it: a new version, or a
      // workspace whose viewport was still in its tree.
      const migrated = (source.workspaces ?? []).some(
        (ws) => (ws as Partial<PersistedWorkspace>).defaultViewport === undefined,
      );
      if (layout.version !== data.version || migrated) {
        this.save(layout);
      } else {
        this.current = layout;
      }
      return layout;
    } catch {
      return null;
    }
  }

  /** Remove a workspace's layout, by its workspace key */
  removeWorkspace(key: WorkspaceKey): void {
    const layout = this.currentOrLoad();
    if (!layout) return;

    layout.workspaces = layout.workspaces.filter(
      (w) => w.workspacePath !== key,
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
      // A legacy Home entry's sessions are being ended (ADR-197 §2).
      if (isHomePath(workspace.workspacePath)) continue;
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
}
