/**
 * Layout, owned by the Manor server (ADR-179 D1/D3).
 *
 * One authority for every renderer on this host. A renderer never writes
 * layout; it sends a `LayoutCommand`, this runs the pure reducer, bumps the
 * workspace's version, ends the sessions the reducer said left the tree,
 * persists, and broadcasts the whole workspace layout back to every window and
 * every bridge socket. Renderers replace their replica on that broadcast —
 * there is no optimistic apply and no second reducer.
 *
 * Three things live here that the reducer deliberately does not own:
 *
 * - **`paneSessions`** — `daemonSessionId`, cwd, title, agent status per pane.
 *   Server-derived (D3): fed by the PTY events `app-lifecycle.ts` already
 *   forwards, not by a renderer telling us what it saw. Never broadcast, for
 *   the same reason: every renderer receives the PTY event itself. They are
 *   here so they reach the *file*, which is what a cold restore reads.
 * - **the closed-pane stack** — server memory, not persisted (D3).
 * - **the default viewport** — one per workspace, handed to a renderer that
 *   has none of its own. Ticket 4 gives `reportViewport` its real shape.
 *
 * One writer: this store owns `~/.manor/layout.json` and writes it whole from
 * its own memory. No renderer writes layout at all (ADR-179 D1) — the desktop
 * and a browser both change it by sending commands here.
 */

import * as crypto from "node:crypto";

import {
  applyLayoutCommand,
  type ClosedPane,
  type LayoutCommand,
  type PaneMetadata,
  type PaneMetadataMap,
} from "../../src/lib/layout/commands";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import {
  type Panel,
  type PaneContentType,
  type Tab,
  type WorkspaceLayout,
  createSinglePanelLayout,
  findPanelWithPane,
} from "../../src/lib/layout/workspace-layout";
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import type { LocalBackend } from "../backend/local-backend";
import {
  type LayoutPersistence,
  type PersistedDefaultViewport,
  type PersistedLayout,
  type PersistedPaneSession,
  type PersistedPanel,
  type PersistedWorkspace,
} from "../terminal-host/layout-persistence";
import type { StreamEvent } from "../terminal-host/types";

/** How long a change waits before it reaches the disk. */
const PERSIST_DEBOUNCE_MS = 300;

/**
 * Who sent a command. Recorded rather than acted on: the sender gets the same
 * broadcast as everybody else (D1). Claims make this load-bearing in ticket 6.
 */
export interface LayoutOrigin {
  kind: "window" | "bridge" | "route";
  id: string;
}

/** A detached window's hold on a tab (D4). Always empty until ticket 6. */
export interface LayoutClaim {
  windowId: string;
  tabId: string;
}

/** What `layout.changed` carries. */
export type LayoutBroadcaster = (
  workspacePath: string,
  version: number,
  layout: WorkspaceLayout,
  claims: LayoutClaim[],
) => void;

export type LayoutApplyResult = { version: number } | { error: string };

/** One workspace as a reader sees it. */
export interface LayoutEntry {
  version: number;
  layout: WorkspaceLayout;
  defaultViewport: PersistedDefaultViewport;
  /** Server-derived; a restoring renderer needs it to reattach sessions. */
  paneSessions: Record<string, PersistedPaneSession>;
}

interface WorkspaceState extends LayoutEntry {
  closedStack: ClosedPane[];
}

/** Every command the reducer answers to. An unknown one is refused, not run. */
const COMMAND_TYPES: ReadonlySet<string> = new Set<LayoutCommand["type"]>([
  "new-tab",
  "close-tab",
  "duplicate-tab",
  "close-other-tabs",
  "close-tabs-to-right",
  "reorder-tabs",
  "toggle-pin-tab",
  "split-pane",
  "split-pane-at",
  "move-pane",
  "move-tab-to-pane",
  "extract-pane-to-tab",
  "close-pane",
  "reopen-closed-pane",
  "set-pane-title",
  "set-pane-content-type",
  "split-panel",
  "close-panel",
  "merge-tab-into-tab",
  "update-panel-ratio",
  "move-tab-to-panel",
  "split-panel-with-tab",
  "split-panel-with-new-tab",
  "update-split-ratio",
]);

/**
 * What every leaf of a workspace renders, keyed by paneId — the half of a
 * pane's metadata that lives in the tree rather than in `paneSessions`.
 */
function treeMetadata(layout: WorkspaceLayout): Record<string, PaneMetadata> {
  const metadata: Record<string, PaneMetadata> = {};
  const walk = (node: PaneNode): void => {
    if (node.type === "leaf") {
      metadata[node.paneId] = {
        contentType: (node.contentType as PaneContentType) ?? "terminal",
        ...(node.url !== undefined && { url: node.url }),
      };
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) walk(tab.rootNode);
  }
  return metadata;
}

export class LayoutStore {
  private readonly entries = new Map<string, WorkspaceState>();
  /** Per-workspace tail of the apply chain: two commands never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Which workspace each renderer last reported a viewport for (ticket 6). */
  private readonly viewportReporters = new Map<string, string>();
  private lastActiveWorkspacePath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly persistence: LayoutPersistence,
    private readonly broadcast: LayoutBroadcaster,
    private readonly backend: Pick<LocalBackend, "pty">,
  ) {}

  /** Read `~/.manor/layout.json` into memory. Migration happens below it. */
  load(): void {
    const file = this.persistence.load();
    if (!file) return;
    this.lastActiveWorkspacePath = file.lastActiveWorkspacePath ?? null;
    for (const workspace of file.workspaces) {
      this.entries.set(workspace.workspacePath, {
        version: 0,
        layout: layoutFromPersisted(workspace),
        defaultViewport: workspace.defaultViewport,
        paneSessions: paneSessionsFromPersisted(workspace),
        closedStack: [],
      });
    }
  }

  /**
   * The workspace the last command touched — the surface to reopen on
   * relaunch. Viewport, strictly (D3), and it lives here only until ticket 4
   * gives each renderer a viewport file of its own.
   */
  getLastActiveWorkspacePath(): string | null {
    return this.lastActiveWorkspacePath;
  }

  getAll(): Record<string, LayoutEntry> {
    const all: Record<string, LayoutEntry> = {};
    for (const [workspacePath, state] of this.entries) {
      all[workspacePath] = snapshot(state);
    }
    return all;
  }

  get(workspacePath: string): LayoutEntry | null {
    const state = this.entries.get(workspacePath);
    return state ? snapshot(state) : null;
  }

  /**
   * The workspace's layout, creating an empty single-panel one if this is the
   * first time the server has heard of it. The panel id is minted here because
   * nothing sent a command yet — every id in a *command* comes from its sender.
   */
  ensure(workspacePath: string): LayoutEntry {
    return snapshot(this.ensureState(workspacePath));
  }

  /**
   * Run one command against one workspace.
   *
   * Serialized per workspace: the returned promise is chained onto the
   * previous command's, so a split that is still killing panes cannot have a
   * close land in the middle of it.
   */
  apply(
    workspacePath: string,
    command: LayoutCommand,
    origin: LayoutOrigin,
  ): Promise<LayoutApplyResult> {
    const previous = this.queues.get(workspacePath) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.applyNow(workspacePath, command, origin));
    this.queues.set(
      workspacePath,
      run.catch(() => {}),
    );
    return run;
  }

  /** Forget a workspace's layout entirely — the worktree is gone. */
  remove(workspacePath: string): void {
    this.entries.delete(workspacePath);
    this.queues.delete(workspacePath);
    if (this.lastActiveWorkspacePath === workspacePath) {
      this.lastActiveWorkspacePath = null;
    }
    // Filters this one workspace out of the file rather than rewriting the
    // whole thing from memory, which is what the renderer's parallel writer
    // (see the header) makes the safer of the two for one more ticket.
    this.persistence.removeWorkspace(workspacePath);
  }

  /**
   * A PTY event, folded into the owning pane's `paneSessions` (D3).
   *
   * Deliberately silent: every renderer already receives this same event
   * through its own `pty.*` subscription, so a `layout.changed` here would be
   * a second delivery of something nobody is missing. It exists to reach disk.
   */
  onPtyEvent(event: StreamEvent): void {
    if (event.type !== "cwd" && event.type !== "agentStatus") return;
    const paneId = event.sessionId;
    const state = this.stateWithPane(paneId);
    if (!state) return;
    const previous = state.paneSessions[paneId] ?? emptySession(paneId);
    state.paneSessions[paneId] =
      event.type === "cwd"
        ? { ...previous, lastCwd: event.cwd }
        : {
            ...previous,
            lastAgentStatus: event.agent,
            lastTitle: event.agent.title ?? previous.lastTitle,
          };
    this.schedulePersist();
  }

  /**
   * What one renderer is looking at. Ticket 4 gives this its real shape — a
   * per-renderer viewport slice with claims; for now the last report wins and
   * becomes the workspace's default viewport.
   */
  reportViewport(
    workspacePath: string,
    rendererId: string,
    viewport: PersistedDefaultViewport,
  ): void {
    const state = this.entries.get(workspacePath);
    if (!state) return;
    this.viewportReporters.set(rendererId, workspacePath);
    state.defaultViewport = viewport;
    this.schedulePersist();
  }

  /** Write any pending change now. Called from `before-quit`. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.persistence.save(this.toPersisted());
    } catch (err) {
      console.error("[layout] failed to persist layout:", err);
    }
  }

  // ───────────────────────────── internals ──────────────────────────────

  private async applyNow(
    workspacePath: string,
    command: LayoutCommand,
    origin: LayoutOrigin,
  ): Promise<LayoutApplyResult> {
    if (
      !command ||
      typeof command !== "object" ||
      !COMMAND_TYPES.has(command.type)
    ) {
      return {
        error: `unknown layout command from ${origin.kind} ${origin.id}: ${
          (command as { type?: string } | null)?.type ?? typeof command
        }`,
      };
    }

    const state = this.ensureState(workspacePath);
    const before = state.layout;

    // Titles have no structural home: they are `paneSessions`, which is ours.
    // Not a structural change, so no version bump and no broadcast — every
    // renderer already saw the title event this came from.
    if (command.type === "set-pane-title") {
      if (!findPanelWithPane(before, command.paneId)) {
        return { version: state.version };
      }
      state.paneSessions[command.paneId] = {
        ...(state.paneSessions[command.paneId] ?? emptySession(command.paneId)),
        lastTitle: command.title,
      };
      this.schedulePersist();
      return { version: state.version };
    }

    const metadata = treeMetadata(before);
    const result = applyLayoutCommand(
      { layout: before, closedStack: state.closedStack },
      command,
      paneMetadata(state, metadata),
    );
    state.closedStack = result.closedStack;

    if (result.layout === before) {
      // A command naming an id that is not in the tree is a no-op, not an
      // error — a stale command from a slow renderer is normal (D1).
      return { version: state.version };
    }

    state.layout = result.layout;
    state.version += 1;
    this.lastActiveWorkspacePath = workspacePath;
    this.schedulePersist();
    this.broadcast(workspacePath, state.version, state.layout, []);

    // Ending sessions is the server's job now (D2): the renderer sends the
    // command after its confirmation dialog, and the effect lands here.
    for (const paneId of result.effects.killPanes) {
      delete state.paneSessions[paneId];
      if ((metadata[paneId]?.contentType ?? "terminal") !== "terminal") continue;
      try {
        await this.backend.pty.kill(paneId);
      } catch (err) {
        console.error(`[layout] failed to kill pane ${paneId}:`, err);
      }
    }

    return { version: state.version };
  }

  private ensureState(workspacePath: string): WorkspaceState {
    const existing = this.entries.get(workspacePath);
    if (existing) return existing;
    const panelId = `panel-${crypto.randomUUID()}`;
    const state: WorkspaceState = {
      version: 0,
      layout: createSinglePanelLayout(panelId, [], "", []),
      defaultViewport: {
        activePanelId: panelId,
        selectedTabIds: {},
        focusedPaneIds: {},
      },
      paneSessions: {},
      closedStack: [],
    };
    this.entries.set(workspacePath, state);
    return state;
  }

  private stateWithPane(paneId: string): WorkspaceState | null {
    for (const state of this.entries.values()) {
      if (findPanelWithPane(state.layout, paneId)) return state;
    }
    return null;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private toPersisted(): PersistedLayout {
    const workspaces: PersistedWorkspace[] = [];
    for (const [workspacePath, state] of this.entries) {
      workspaces.push({
        workspacePath,
        panelTree: state.layout.panelTree,
        panels: persistedPanels(state),
        activePanelId: state.layout.activePanelId,
        defaultViewport: state.defaultViewport,
      });
    }
    return {
      version: 3,
      workspaces,
      lastActiveWorkspacePath: this.lastActiveWorkspacePath,
    };
  }
}

// ──────────────────────────── shape conversion ────────────────────────────

function snapshot(state: WorkspaceState): LayoutEntry {
  return {
    version: state.version,
    layout: state.layout,
    defaultViewport: state.defaultViewport,
    paneSessions: state.paneSessions,
  };
}

function emptySession(paneId: string): PersistedPaneSession {
  // `daemonSessionId === paneId` — see `ptyCreate` in `electron/ipc/pty.ts`.
  return { daemonSessionId: paneId, lastCwd: null, lastTitle: null };
}

/**
 * What the reopen stack needs about every pane, from what the server knows.
 *
 * A pane's content type, url, cwd and title all live here — the first two in
 * the tree the command is about to change, the last two in `paneSessions`. No
 * sender is asked for them: `applyLayoutCommand` takes this map as its third
 * argument, and the closing commands are the only ones that read it (D3).
 */
function paneMetadata(
  state: WorkspaceState,
  treeMeta: Record<string, PaneMetadata>,
): PaneMetadataMap {
  const metadata: PaneMetadataMap = {};
  for (const [paneId, tree] of Object.entries(treeMeta)) {
    const session = state.paneSessions[paneId];
    metadata[paneId] = {
      ...tree,
      ...(session?.lastCwd != null && { cwd: session.lastCwd }),
      ...(session?.lastTitle != null && { title: session.lastTitle }),
    };
  }
  return metadata;
}

function layoutFromPersisted(workspace: PersistedWorkspace): WorkspaceLayout {
  const panels: Record<string, Panel> = {};
  for (const [panelId, panel] of Object.entries(workspace.panels ?? {})) {
    panels[panelId] = {
      id: panel.id,
      tabs: panel.tabs.map(
        (tab): Tab => ({
          id: tab.id,
          title: tab.title,
          rootNode: tab.rootNode,
          focusedPaneId: tab.focusedPaneId,
        }),
      ),
      selectedTabId: panel.selectedTabId,
      pinnedTabIds: panel.pinnedTabIds ?? [],
    };
  }
  return {
    panelTree: workspace.panelTree,
    panels,
    activePanelId: workspace.activePanelId,
  };
}

/** The file keeps `paneSessions` per tab; the server keeps one map per
 *  workspace, because a pane that moves between tabs keeps its session. */
function paneSessionsFromPersisted(
  workspace: PersistedWorkspace,
): Record<string, PersistedPaneSession> {
  const sessions: Record<string, PersistedPaneSession> = {};
  for (const panel of Object.values(workspace.panels ?? {})) {
    for (const tab of panel.tabs) {
      for (const [paneId, session] of Object.entries(tab.paneSessions ?? {})) {
        sessions[paneId] = session;
      }
    }
  }
  return sessions;
}

function persistedPanels(
  state: WorkspaceState,
): Record<string, PersistedPanel> {
  const panels: Record<string, PersistedPanel> = {};
  for (const [panelId, panel] of Object.entries(state.layout.panels)) {
    panels[panelId] = {
      id: panel.id,
      tabs: panel.tabs.map((tab) => {
        const paneSessions: Record<string, PersistedPaneSession> = {};
        for (const paneId of allPaneIds(tab.rootNode)) {
          const session = state.paneSessions[paneId];
          if (session) paneSessions[paneId] = session;
        }
        return {
          id: tab.id,
          title: tab.title,
          rootNode: tab.rootNode,
          focusedPaneId: tab.focusedPaneId,
          paneSessions,
        };
      }),
      selectedTabId: panel.selectedTabId,
      pinnedTabIds: panel.pinnedTabIds ?? [],
    };
  }
  return panels;
}
