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
import * as os from "node:os";
import { allPaneIds, type PaneNode } from "../../src/store/pane-tree";

export const LAYOUT_FILE = path.join(os.homedir(), ".manor", "layout.json");

/** Persisted pane → daemon session mapping */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
  lastTitle: string | null;
}

/** Persisted session (tab) layout */
export interface PersistedSession {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
  paneSessions: Record<string, PersistedPaneSession>;
}

/** Persisted workspace state */
export interface PersistedWorkspace {
  workspacePath: string;
  sessions: PersistedSession[];
  selectedSessionId: string;
}

/** Full persisted layout */
export interface PersistedLayout {
  version: 1;
  workspaces: PersistedWorkspace[];
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

  /** Load the layout from disk. Returns null if file doesn't exist. */
  load(): PersistedLayout | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as PersistedLayout;
    } catch {
      return null;
    }
  }

  /** Save a single workspace's layout (upsert by workspacePath) */
  saveWorkspace(workspace: PersistedWorkspace): void {
    let layout = this.load();
    if (!layout) {
      layout = { version: 1, workspaces: [] };
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

    for (const session of workspace.sessions) {
      const paneIds = allPaneIds(session.rootNode);

      for (const paneId of paneIds) {
        const paneSession = session.paneSessions[paneId];
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
