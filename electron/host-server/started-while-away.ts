/**
 * The "Started while away" tab (ADR-218 D5).
 *
 * The phone walks the last layout snapshot the desktop pushed. A session the
 * daemon started after that push — an agent launched from the box's own
 * shell, a terminal opened while the desktop was off — is in no layout, so a
 * phone with the lid closed could not find it. This appends such sessions to
 * the workspace they run in, as one synthetic tab.
 *
 * Nothing is persisted: the tab is computed on every read, from the snapshot
 * and the daemon's live sessions. Ids derive from the workspace path and the
 * session ids (never a counter or a clock), so two reads of the same state
 * are equal and the phone does not remount.
 */

import type { PaneNode } from "../../src/lib/layout/pane-tree";
import { allPanelIds } from "../../src/lib/layout/panel-tree";
import type { LayoutEntry, PersistedPaneSession } from "../../src/lib/layout/protocol";
import {
  layoutPaneIds,
  type Panel,
  type Tab,
  type WorkspaceLayout,
} from "../../src/lib/layout/workspace-layout";
import { emptyViewport } from "../../src/lib/layout/viewport";
import type { SessionInfo } from "../terminal-host/types";

export const STARTED_WHILE_AWAY_TITLE = "Started while away";

/** The pane ids and daemon session ids the snapshot already places. */
export function knownSessionIds(
  workspaces: Record<string, LayoutEntry>,
): Set<string> {
  const known = new Set<string>();
  for (const entry of Object.values(workspaces)) {
    for (const id of layoutPaneIds(entry.layout)) known.add(id);
    for (const [paneId, ps] of Object.entries(entry.paneSessions)) {
      known.add(paneId);
      if (ps.daemonSessionId) known.add(ps.daemonSessionId);
    }
  }
  return known;
}

/** Live sessions the snapshot does not place, in a stable order. */
export function missingSessions(
  workspaces: Record<string, LayoutEntry>,
  sessions: readonly SessionInfo[],
): SessionInfo[] {
  const known = knownSessionIds(workspaces);
  return sessions
    .filter((s) => s.alive && !known.has(s.sessionId))
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}

/** The longest workspace path `cwd` is at or under, or null. */
function workspaceOf(cwd: string | null, paths: readonly string[]): string | null {
  if (!cwd) return null;
  let best: string | null = null;
  for (const raw of paths) {
    const p = raw.replace(/\/+$/, "");
    if (!p) continue;
    if (cwd === p || cwd.startsWith(`${p}/`)) {
      if (!best || p.length > best.length) best = p;
    }
  }
  return best;
}

/** A column of panes, one per session, in the given order. */
function stack(paneIds: readonly string[]): PaneNode {
  const [first, ...rest] = paneIds;
  const leaf: PaneNode = { type: "leaf", paneId: first, contentType: "terminal" };
  if (rest.length === 0) return leaf;
  return {
    type: "split",
    direction: "vertical",
    ratio: 1 / paneIds.length,
    first: leaf,
    second: stack(rest),
  };
}

/** A layout of one panel holding just `tab`, for a workspace that has none. */
function singleTabPanel(workspacePath: string, tab: Tab): WorkspaceLayout {
  const panelId = `away-panel:${workspacePath}`;
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: { id: panelId, tabs: [tab], pinnedTabIds: [] } },
  };
}

/**
 * `workspaces` with the missing sessions appended as a "Started while away"
 * tab in the workspace each runs in. A workspace with no layout yet gets one
 * panel holding just that tab. The input is not mutated.
 */
export function withStartedWhileAway(
  workspaces: Record<string, LayoutEntry>,
  missing: readonly SessionInfo[],
  workspacePaths: readonly string[],
): Record<string, LayoutEntry> {
  const byWorkspace = new Map<string, SessionInfo[]>();
  for (const session of missing) {
    const path = workspaceOf(session.cwd, workspacePaths);
    if (!path) continue;
    byWorkspace.set(path, [...(byWorkspace.get(path) ?? []), session]);
  }
  if (byWorkspace.size === 0) return workspaces;

  const out = { ...workspaces };
  for (const [path, sessions] of byWorkspace) {
    const tab: Tab = {
      id: `away:${path}`,
      title: STARTED_WHILE_AWAY_TITLE,
      rootNode: stack(sessions.map((s) => s.sessionId)),
    };
    const paneSessions: Record<string, PersistedPaneSession> = {};
    for (const s of sessions) {
      paneSessions[s.sessionId] = {
        daemonSessionId: s.sessionId,
        lastCwd: s.cwd,
        lastTitle: null,
      };
    }
    const entry = out[path];
    if (!entry) {
      out[path] = {
        version: 0,
        layout: singleTabPanel(path, tab),
        defaultViewport: emptyViewport(),
        paneSessions,
        claims: [],
      };
      continue;
    }
    // The first panel in tree order that exists; a layout with none gets one.
    const host =
      allPanelIds(entry.layout.panelTree).find((id) => entry.layout.panels[id]) ??
      Object.keys(entry.layout.panels)[0];
    const layout = host
      ? {
          ...entry.layout,
          panels: {
            ...entry.layout.panels,
            [host]: {
              ...entry.layout.panels[host],
              tabs: [...entry.layout.panels[host].tabs, tab],
            } satisfies Panel,
          },
        }
      : singleTabPanel(path, tab);
    out[path] = {
      ...entry,
      layout,
      paneSessions: { ...entry.paneSessions, ...paneSessions },
    };
  }
  return out;
}
