/**
 * Layout, owned by the Manor server.
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
 *   Server-derived: fed by the PTY events `app-lifecycle.ts` already
 *   forwards, not by a renderer telling us what it saw. Not broadcast, for
 *   the same reason: every renderer receives the PTY event itself. They are
 *   here so they reach the *file*, which is what a cold restore reads — and
 *   so a reopened pane can be handed back what it knew (`restored`), which is
 *   the one time they are broadcast.
 * - **the closed-pane stack** — server memory, not persisted, and the
 *   grace that keeps its panes' shells alive long enough to be reopened.
 * - **the default viewport** — one per workspace, last writer wins, handed
 *   to a renderer that has none of its own. Nothing here *decides*
 *   anything from it: which tab a window is showing is that window's.
 *
 * Workspaces are keyed by their host-qualified `WorkspaceKey`: a
 * bare path on this machine, `<hostId>:<path>` on a remote host, so a local
 * and a remote workspace at the same path each have their own layout. Every
 * `workspacePath` parameter and field below holds one — the name is kept
 * for the same reason `PersistedWorkspace.workspacePath` kept it. Members of
 * a linked project group are ordinary single-host projects, so
 * their workspaces need nothing more than their keys.
 *
 * Home is the Dashboard and never holds tabs: a command for it is
 * refused, and a legacy Home entry in the file is dropped on load, its
 * panes ended — agents abandoned, shells killed.
 *
 * One writer: this store owns `~/.manor/layout.json` and writes it whole from
 * its own memory. No renderer writes layout at all — the desktop
 * and a browser both change it by sending commands here.
 */

import * as crypto from "node:crypto";

import {
  applyLayoutCommand,
  findLeaf,
  isLayoutCommandType,
  receiveTab,
  sendTab,
  type ClosedPane,
  type LayoutCommand,
} from "../../src/lib/layout/commands";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import type { WorkspaceViewport } from "../../src/lib/layout/viewport";
import type { LayoutClaim } from "../../src/lib/layout/visible-tabs";
import type {
  LayoutApplyResult,
  LayoutBroadcast,
  LayoutEntry,
  LayoutOrigin,
  PersistedPaneSession,
  WorkspaceMoveResult,
} from "../../src/lib/layout/protocol";
import {
  type Panel,
  type Tab,
  type WorkspaceLayout,
  createSinglePanelLayout,
  findPanelWithPane,
  findPanelWithTab,
  layoutPaneIds,
} from "../../src/lib/layout/workspace-layout";
import { isHomePath } from "../../src/lib/home-path";
import {
  crossHostMoveRefusal,
  isRemoteWorkspaceKey,
  parseWorkspaceKey,
  type WorkspaceKey,
} from "../../src/lib/workspace-key";
import { PendingCommands } from "./pending-commands";
import {
  KEYED_LAYOUT_VERSION,
  LAYOUT_VERSION,
  type LayoutPersistence,
  type PersistedLayout,
  type PersistedPanel,
  type PersistedWorkspace,
} from "../terminal-host/layout-persistence";
import type { StreamEvent } from "../terminal-host/types";

/** How long a change waits before it reaches the disk. */
const PERSIST_DEBOUNCE_MS = 300;

/**
 * How long a closed terminal pane's session outlives its pane.
 *
 * "Reopen closed pane" is an undo, and an undo that hands back a fresh shell
 * has undone nothing a user cares about — the scrollback, the cwd and the
 * half-typed command are the point. So the kill the reducer asked for is
 * scheduled rather than run, and a reopen inside the window cancels it and
 * reattaches the shell that is still there.
 *
 * The same 10s the renderer used before session-ending moved to the server;
 * there is exactly one grace, and it is this one.
 */
export const REOPEN_GRACE_MS = 10_000;

/** A closed pane's session, still warm, waiting out {@link REOPEN_GRACE_MS}. */
interface PendingKill {
  workspacePath: string;
  timer: ReturnType<typeof setTimeout>;
}

/** The wire types are `src/lib/layout/protocol.ts`'s, shared with every renderer. */
export type { LayoutBroadcast, LayoutOrigin };

export type LayoutBroadcaster = (payload: LayoutBroadcast) => void;

/** What the store needs of the backend: ending a closed pane's session. */
export interface LayoutStoreBackend {
  pty: { kill(sessionId: string): Promise<void> };
}

/** A pane whose session is ending, and the title to name its agent by. */
export interface EndedPane {
  paneId: string;
  title?: string | null;
}

/**
 * The agents side of a pane leaving a tree.
 *
 * Every pane this store ends — a close of any size, a whole workspace going
 * away — goes through `abandonForPanes` first, so an agent running in it is
 * marked abandoned whichever renderer, route or bridge caller did the
 * closing. Backed by `createAgentService` in `bridge/handlers/agents.ts`.
 */
export interface AgentService {
  abandonForPanes(panes: readonly EndedPane[]): void;
  /**
   * Panes that moved to another workspace, still running: an agent in one
   * now belongs to `workspacePath` (a workspace key). Optional, for the
   * tests that are not about agents.
   */
  moveToWorkspace?(paneIds: readonly string[], workspacePath: string): void;
}

/**
 * Whether a move from one workspace to another is allowed, beyond what the
 * store can tell from the keys alone: both are workspaces of the same
 * project. The refusal's message, or null. Backed by `projectWorkspaceCheck`
 * (`./workspace-move-check.ts`), so the store never reads projects itself.
 */
export type WorkspaceMoveCheck = (
  from: WorkspaceKey,
  to: WorkspaceKey,
) => Promise<string | null>;

const NO_AGENTS: AgentService = { abandonForPanes() {} };

/**
 * Starts a pane's session on the server: told about every pane a
 * command adds whose queued command launches on apply — an agent's startup
 * line, a setup script. Told before the broadcast that makes a renderer mount
 * the pane, so its spawn is already under way when the renderer's
 * `pty.create` arrives, and that create attaches. Backed by
 * `createServerLaunches` in `../server/spawn-pane.ts`.
 */
export interface PaneLauncher {
  launch(workspacePath: string, paneId: string): void;
}

const NO_LAUNCHER: PaneLauncher = { launch() {} };

/**
 * What main knows about a desktop window, by renderer id.
 *
 * Asked rather than told, because both answers change as windows come and
 * go. `claimOf` is the tab a detached window was opened to hold — its launch
 * argument, which main wrote — so a claim never travels inside a viewport a
 * renderer reports.
 */
export interface WindowDirectory {
  isPrimary(rendererId: string): boolean;
  claimOf(rendererId: string): { workspacePath: string; tabId: string } | null;
}

const NO_WINDOWS: WindowDirectory = {
  isPrimary: () => false,
  claimOf: () => null,
};

/** The file, as far as this store uses it; a test hands in memory. */
export type LayoutFile = Pick<
  LayoutPersistence,
  "load" | "save" | "removeWorkspace"
>;

interface WorkspaceState
  extends Omit<LayoutEntry, "claims"> {
  closedStack: ClosedPane[];
}

/** Every tab a workspace holds, across every panel. */
function layoutTabIds(layout: WorkspaceLayout): Set<string> {
  const ids = new Set<string>();
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) ids.add(tab.id);
  }
  return ids;
}

/** A pane or a tab, named by id — either lives in exactly one workspace. */
export type LayoutTarget = { paneId: string } | { tabId: string };

export class LayoutStore {
  private readonly entries = new Map<string, WorkspaceState>();
  /** Per-workspace tail of the apply chain: two commands never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * How many times each workspace has been removed. A command reads this when
   * it is queued and refuses to run if a `remove` landed in between, so a
   * command still waiting its turn cannot bring a removed workspace back
   * through `ensureState`.
   */
  private readonly removals = new Map<string, number>();
  /**
   * The primary window's last viewport, per workspace, and the last one any
   * window reported as the fallback.
   *
   * `list_panes` means "what is the desk showing", which is the primary's
   * answer and nobody else's: a browser's selection is not it, and neither is
   * a detached window's one tab. The fallback covers the window that reported
   * before main could tell us it was primary, and the case of no primary at
   * all (its window closed while popouts kept running).
   */
  private readonly windowViewports = new Map<string, WorkspaceViewport>();
  private readonly primaryViewports = new Map<string, WorkspaceViewport>();
  /**
   * Which window holds which tab, keyed by the window's renderer id.
   *
   * Exclusive by construction: one entry per window, and a second window
   * claiming a tab evicts the first, which hears about it on the broadcast
   * this makes and closes itself. Never persisted — a claim is a fact about a
   * window that is open right now.
   */
  private readonly claims = new Map<
    string,
    { workspacePath: string; tabId: string }
  >();
  /** Sessions of closed panes serving out their grace, keyed by paneId. */
  private readonly pendingKills = new Map<string, PendingKill>();
  /**
   * Commands queued for panes whose shells do not exist yet.
   *
   * Here because every producer of one already holds the store — the
   * structural routes, `POST /agents`, `layout.setPendingCommand` — and
   * because a pane that leaves the tree must drop its command, which is
   * something only this class hears about. See `pending-commands.ts`.
   */
  readonly pendingCommands = new PendingCommands();
  private lastActiveWorkspacePath: string | null = null;
  /**
   * Whether the file's workspaces are keyed by `WorkspaceKey`. A
   * file whose key migration could not run yet (a remote host did not
   * answer) is written back as version 2, so the migration retries next
   * launch; see `LayoutPersistence.startWorkspaceKeyMigration`.
   */
  private keyed = true;
  /** Settles once the file has been read; see {@link startLoad}. */
  private loaded: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly persistListeners = new Set<() => void>();
  /** Told when a claim moves on a workspace this store does not hold. */
  private readonly foreignClaimListeners = new Set<
    (workspacePath: string, origin: LayoutOrigin) => void
  >();

  /**
   * @param windows Which renderer is the primary window, and which tab a
   * detached one holds. A store built without it has no primary — it falls
   * back to the most recent window report — and no claims.
   */
  constructor(
    private readonly persistence: LayoutFile,
    private readonly broadcast: LayoutBroadcaster,
    private readonly backend: LayoutStoreBackend,
    private readonly windows: WindowDirectory = NO_WINDOWS,
    /**
     * A pane's title, off the command channel. Optional, and a no-op by
     * default, so every existing caller of this constructor keeps working —
     * only `app-lifecycle.ts` needs to say what "publish" means here, the
     * same `publishRendererBroadcast` `broadcast` above is built from.
     */
    private readonly publishPaneTitle: (
      paneId: string,
      title: string | null,
    ) => void = () => {},
    /**
     * Ends the agents of the panes this store ends. Defaults to doing
     * nothing, for the tests that are not about agents; `app-lifecycle.ts`
     * passes the real one.
     */
    private readonly agents: AgentService = NO_AGENTS,
    /**
     * Spawns the sessions of panes whose queued command is a launch.
     * Defaults to doing nothing — the pane then waits for a renderer, as
     * every pane once did; `createManorServer` passes the real one.
     */
    private readonly launcher: PaneLauncher = NO_LAUNCHER,
    /**
     * The version every workspace starts at in this run. Versions live only
     * in memory, so a server that restarted at 0 would be outranked by the
     * versions its clients still hold from its last run — a desktop's host
     * cache, a window's replica — and every broadcast it sent would be
     * dropped as stale. `createManorServer` passes the clock, so a new run
     * always starts above the last one; tests keep 0.
     */
    private readonly versionBase: number = 0,
  ) {}

  /**
   * Read the file once `ready` settles — the persistence's workspace-key
   * migration, which may wait on a remote host. Commands and
   * readers that can wait for it go through {@link whenLoaded}.
   */
  startLoad(ready: Promise<void>): Promise<void> {
    this.loaded = ready
      .catch(() => {})
      .then(() => this.load());
    return this.loaded;
  }

  /** Resolves once the file has been read into memory. */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /**
   * Read `~/.manor/layout.json` into memory. Migration happens below it.
   *
   * Replaces entries rather than skipping ones already present (the "a
   * second load never clobbers" guard the store once had), and that is safe
   * because nothing can be clobbered: production reads the file once, through
   * `startLoad` at boot — a window reload, a host reconnect and the key
   * migration all go through `whenLoaded`/`apply`, never `load` — and the
   * only paths that create an entry (`apply` → `ensureState`, and
   * `moveWorkspaces`) wait for `this.loaded` first. A new caller of `load`
   * after boot would need that guard back.
   */
  load(): void {
    const file = this.persistence.load();
    if (!file) return;
    this.keyed = file.version >= KEYED_LAYOUT_VERSION;
    this.lastActiveWorkspacePath = file.lastActiveWorkspacePath ?? null;
    for (const workspace of file.workspaces) {
      // Home is the Dashboard and never holds tabs. An entry an
      // older version saved for it is dropped, and its panes end the way a
      // removed workspace's do — agents abandoned, shells
      // killed: nothing will ever mount those panes again.
      if (isHomePath(workspace.workspacePath)) {
        this.dropLegacyHome(workspace);
        continue;
      }
      this.entries.set(workspace.workspacePath, {
        version: this.versionBase,
        layout: layoutFromPersisted(workspace),
        defaultViewport: workspace.defaultViewport,
        paneSessions: paneSessionsFromPersisted(workspace),
        closedStack: [],
      });
    }
  }

  /** End a legacy Home entry's panes and drop it from the file (see `load`). */
  private dropLegacyHome(workspace: PersistedWorkspace): void {
    const state: WorkspaceState = {
      version: 0,
      layout: layoutFromPersisted(workspace),
      defaultViewport: workspace.defaultViewport,
      paneSessions: paneSessionsFromPersisted(workspace),
      closedStack: [],
    };
    this.endPanes(
      workspace.workspacePath,
      state,
      state.layout,
      [...layoutPaneIds(state.layout)],
      { grace: false },
    );
    this.schedulePersist();
  }

  /**
   * The workspace the last command touched.
   *
   * A renderer reopens on its *own* last surface, out of its own viewport
   * file; this is the fallback for one that has never saved a viewport —
   * a first launch, a browser that has just been paired.
   */
  getLastActiveWorkspacePath(): string | null {
    return this.lastActiveWorkspacePath;
  }

  getAll(): Record<string, LayoutEntry> {
    const all: Record<string, LayoutEntry> = {};
    for (const [workspacePath, state] of this.entries) {
      all[workspacePath] = snapshot(state, this.claimsFor(workspacePath));
    }
    return all;
  }

  get(workspacePath: string): LayoutEntry | null {
    const state = this.entries.get(workspacePath);
    return state ? snapshot(state, this.claimsFor(workspacePath)) : null;
  }

  /**
   * The workspace holding a pane or a tab, and its entry; null when no
   * workspace does.
   */
  locate(
    target: LayoutTarget,
  ): { workspacePath: string; entry: LayoutEntry } | null {
    const found = this.find(target);
    if (!found) return null;
    const { workspacePath, state } = found;
    return {
      workspacePath,
      entry: snapshot(state, this.claimsFor(workspacePath)),
    };
  }

  /** The key of the workspace whose tree holds `paneId`, or null. */
  workspaceOf(paneId: string): string | null {
    return this.find({ paneId })?.workspacePath ?? null;
  }

  /**
   * Run one command against one workspace.
   *
   * Serialized per workspace: the returned promise is chained onto the
   * previous command's, so a split that is still killing panes cannot have a
   * close land in the middle of it.
   *
   * A close the server makes itself (a setup script's tab, when its shell
   * exits) passes `remember: false`: nobody closed that tab, so "reopen
   * closed pane" must not bring it back.
   */
  apply(
    workspacePath: string,
    command: LayoutCommand,
    origin: LayoutOrigin,
    { remember = true }: { remember?: boolean } = {},
  ): Promise<LayoutApplyResult> {
    // Home is the Dashboard and never holds tabs.
    if (isHomePath(workspacePath)) {
      return Promise.resolve({ error: "The Dashboard can't host panes" });
    }
    const loaded = this.loaded;
    const previous = (this.queues.get(workspacePath) ?? Promise.resolve()).then(
      () => loaded,
    );
    const removals = this.removals.get(workspacePath) ?? 0;
    const run = previous
      .catch(() => {})
      .then(() =>
        (this.removals.get(workspacePath) ?? 0) === removals
          ? this.applyNow(workspacePath, command, origin, remember)
          : { error: `Workspace was removed: ${workspacePath}` },
      );
    this.queues.set(
      workspacePath,
      run.catch(() => {}),
    );
    return run;
  }

  /**
   * Move a tab, or one pane, from workspace `from` to workspace `to` without
   * ending it: the shell or agent keeps running, with its scrollback and cwd.
   *
   * It lands as a new tab in the target's active panel (the primary window's,
   * else the default viewport's, else the first). A moved tab keeps its split
   * tree, its pinned state and its pane ids; a moved pane leaves its tab's
   * other panes behind and travels in a tab of its own, named `newTabId`
   * (minted here when the caller does not). Nothing is killed and the reopen
   * stack is not touched: a move is not a close. The source keeps its last
   * panel, empty, when its last tab leaves.
   *
   * Serialized in both workspaces' queues: the move waits for whatever either
   * was running and both wait for it, and both layouts change in the same
   * synchronous step — there is no moment the pane is in neither, or both.
   * Waiting on two tails cannot deadlock: a tail is always an earlier
   * promise, never one that waits on this. A pane's session row, a pending
   * kill and its agent's workspace follow it; a queued command is keyed by
   * pane and needs nothing. A detached window holding a tab that left
   * `from` loses its claim, as when its tab closes. Both workspaces are
   * broadcast, the target's with the sender's selection hint.
   *
   * Refused: the same workspace, Home, two hosts, a target the pane or tab
   * is not in `from`, and whatever `check` refuses (another project, a
   * workspace no project has), which runs inside the queues.
   */
  moveToWorkspace(
    from: string,
    target: LayoutTarget,
    to: string,
    origin: LayoutOrigin,
    {
      check,
      newTabId = `tab-${crypto.randomUUID()}`,
    }: { check?: WorkspaceMoveCheck; newTabId?: string } = {},
  ): Promise<WorkspaceMoveResult> {
    const refusal = moveRefusal(from, to);
    if (refusal) return Promise.resolve({ error: refusal });
    const loaded = this.loaded;
    const previous = Promise.all([
      this.queues.get(from),
      this.queues.get(to),
    ]).then(() => loaded);
    const removals = new Map(
      [from, to].map((key) => [key, this.removals.get(key) ?? 0]),
    );
    const removed = (): WorkspaceMoveResult | null => {
      for (const [key, count] of removals) {
        if ((this.removals.get(key) ?? 0) !== count) {
          return { error: `Workspace was removed: ${key}` };
        }
      }
      return null;
    };
    const run = previous
      .catch(() => {})
      .then(async (): Promise<WorkspaceMoveResult> => {
        const before = removed();
        if (before) return before;
        const refused = check
          ? await check(from as WorkspaceKey, to as WorkspaceKey)
          : null;
        if (refused) return { error: refused };
        return removed() ?? this.moveNow(from, target, to, origin, newTabId);
      });
    const tail = run.catch(() => {});
    this.queues.set(from, tail);
    this.queues.set(to, tail);
    return run;
  }

  /**
   * Move each `[from, to]` workspace key's layout to `to` — a project moved
   * to another host keeps its workspaces' layouts. A `to` that
   * already has a layout keeps it, and `from` is then left in place.
   *
   * In a file whose key migration has not run yet, a bare `from` is left for
   * that migration, which gives it to whichever host owns the path then: the
   * moved project's new one. A qualified entry is already a real key.
   *
   * Each move is broadcast at `to`; a renderer moves its own replica and
   * viewport from `from` to `to` itself (`moveWorkspaceLayout`), as it does
   * on `remove`.
   */
  async moveWorkspaces(
    moves: ReadonlyArray<readonly [WorkspaceKey, WorkspaceKey]>,
  ): Promise<void> {
    await this.loaded;
    const origin: LayoutOrigin = { kind: "route", id: "layout-move" };
    for (const [from, to] of moves) {
      if (from === to) continue;
      if (!this.keyed && !isRemoteWorkspaceKey(from)) continue;
      if (this.entries.has(to)) continue;
      const state = this.entries.get(from);
      if (!state) continue;
      this.entries.delete(from);
      this.queues.delete(from);
      this.windowViewports.delete(from);
      this.primaryViewports.delete(from);
      this.entries.set(to, state);
      for (const claim of this.claims.values()) {
        if (claim.workspacePath === from) claim.workspacePath = to;
      }
      for (const kill of this.pendingKills.values()) {
        if (kill.workspacePath === from) kill.workspacePath = to;
      }
      if (this.lastActiveWorkspacePath === from) {
        this.lastActiveWorkspacePath = to;
      }
      state.version += 1;
      this.schedulePersist();
      this.broadcast({
        workspacePath: to,
        version: state.version,
        layout: state.layout,
        claims: this.claimsFor(to),
        origin,
      });
    }
  }

  /**
   * Forget a workspace's layout entirely — the worktree is gone.
   *
   * Every pane still in it ends the way a closed one does — its agent
   * abandoned, its shell killed — but at once: a removed worktree is a
   * directory about to be deleted, and there is nothing left to reopen a pane
   * *into*. The same goes for the pending kills of panes closed a moment
   * earlier.
   *
   * `ProjectManager.removeWorktree` and `removeProject` call this, so a
   * worktree removed from the sidebar, the CLI or MCP is torn down the same
   * way. A command queued before this and not yet run is refused (see
   * `removals`).
   */
  remove(workspacePath: string): void {
    this.removals.set(workspacePath, (this.removals.get(workspacePath) ?? 0) + 1);
    const state = this.entries.get(workspacePath);
    if (state) {
      this.endPanes(workspacePath, state, state.layout, [
        ...layoutPaneIds(state.layout),
      ], { grace: false });
    }
    this.entries.delete(workspacePath);
    this.queues.delete(workspacePath);
    this.windowViewports.delete(workspacePath);
    this.primaryViewports.delete(workspacePath);
    for (const [windowId, claim] of [...this.claims]) {
      if (claim.workspacePath === workspacePath) this.claims.delete(windowId);
    }
    if (this.lastActiveWorkspacePath === workspacePath) {
      this.lastActiveWorkspacePath = null;
    }
    this.runPendingKills(workspacePath);
    this.persistence.removeWorkspace(workspacePath as WorkspaceKey);
    this.notifyPersisted();

    // Every renderer drops its copy on this, rather than each one tearing the
    // workspace down itself: `removed` is what tells it the workspace is gone
    // rather than changed, so it is not re-adopted, and a popout holding one
    // of its tabs closes. Same version: nothing structural happened first.
    if (state) {
      this.broadcast({
        workspacePath,
        version: state.version,
        layout: state.layout,
        claims: [],
        origin: { kind: "route", id: "layout-remove" },
        removed: true,
      });
    }
  }

  /**
   * On a host server: take in the layout the desktop held for this host
   * keyed by bare path. The host wins: a workspace it already
   * has keeps its own layout, and only the rest are added — each broadcast,
   * so a connected phone sees it. `lastActive` is taken only when this store
   * has none. Written at once. Returns the workspaces added.
   */
  async adopt(
    workspaces: Readonly<Record<string, LayoutEntry>>,
    lastActive: string | null,
  ): Promise<string[]> {
    await this.loaded;
    const origin: LayoutOrigin = { kind: "route", id: "layout-adopt" };
    const added: string[] = [];
    for (const [workspacePath, entry] of Object.entries(workspaces)) {
      if (isHomePath(workspacePath) || this.entries.has(workspacePath)) continue;
      const layout = structuredClone(entry.layout);
      const firstPanelId = Object.keys(layout.panels)[0] ?? null;
      const state: WorkspaceState = {
        version: entry.version,
        layout,
        defaultViewport: entry.defaultViewport
          ? structuredClone(entry.defaultViewport)
          : { activePanelId: firstPanelId, selectedTabIds: {}, focusedPaneIds: {} },
        paneSessions: structuredClone(entry.paneSessions),
        closedStack: [],
      };
      this.entries.set(workspacePath, state);
      added.push(workspacePath);
      this.broadcast({
        workspacePath,
        version: state.version,
        layout: state.layout,
        claims: this.claimsFor(workspacePath),
        origin,
      });
    }
    if (this.lastActiveWorkspacePath === null && lastActive !== null) {
      this.lastActiveWorkspacePath = lastActive;
    }
    this.dirty = true;
    this.persistNow();
    return added;
  }

  /**
   * Let go of workspaces whose layout now lives on another server — a remote
   * host's, once it has adopted them. Unlike `remove` this ends
   * nothing: their panes, sessions and agents carry on, on that host. Every
   * renderer drops its copy, as on `remove`, and a command still queued for
   * one is refused. Written at once.
   */
  async release(workspacePaths: readonly string[]): Promise<void> {
    await this.loaded;
    for (const workspacePath of workspacePaths) {
      const state = this.entries.get(workspacePath);
      if (!state) continue;
      this.removals.set(workspacePath, (this.removals.get(workspacePath) ?? 0) + 1);
      this.entries.delete(workspacePath);
      this.queues.delete(workspacePath);
      this.windowViewports.delete(workspacePath);
      this.primaryViewports.delete(workspacePath);
      for (const [windowId, claim] of [...this.claims]) {
        if (claim.workspacePath === workspacePath) this.claims.delete(windowId);
      }
      if (this.lastActiveWorkspacePath === workspacePath) {
        this.lastActiveWorkspacePath = null;
      }
      this.broadcast({
        workspacePath,
        version: state.version,
        layout: state.layout,
        claims: [],
        origin: { kind: "route", id: "layout-release" },
        removed: true,
      });
    }
    this.dirty = true;
    this.persistNow();
  }

  /**
   * A PTY event, folded into the owning pane's `paneSessions`.
   *
   * Deliberately silent: every renderer already receives this same event
   * through its own `pty.*` subscription, so a `layout.changed` here would be
   * a second delivery of something nobody is missing. It exists to reach disk.
   */
  onPtyEvent(event: StreamEvent): void {
    if (event.type === "cwd") {
      this.updateSession(event.sessionId, (previous) =>
        previous.lastCwd === event.cwd ? previous : { ...previous, lastCwd: event.cwd },
      );
    } else if (event.type === "paneFacts") {
      // The terminal title is one of the pane's facts.
      const title = event.facts.title;
      if (title === null) return;
      this.updateSession(event.sessionId, (previous) =>
        previous.lastTitle === title ? previous : { ...previous, lastTitle: title },
      );
    }
  }

  /**
   * A session the server just spawned for a pane, folded into
   * its `paneSessions` row so the file names it from the start — before the
   * shell's first `cwd` event, and with no renderer to have seen it. Silent,
   * like {@link onPtyEvent}.
   */
  recordSpawn(paneId: string, cwd: string): void {
    this.updateSession(paneId, (previous) =>
      previous.lastCwd !== null ? previous : { ...previous, lastCwd: cwd },
    );
  }

  /**
   * A pane's Agent status, as the Status reconciler published it — folded into `paneSessions` so a cold restore can show it. Silent
   * for the same reason as {@link onPtyEvent}: every renderer hears the same
   * update on its own `agents.status` subscription.
   */
  onPaneStatus(update: {
    paneId: string;
    status: string;
    reason: string;
    kind: string | null;
  }): void {
    const { paneId, ...status } = update;
    this.updateSession(paneId, (previous) => ({
      ...previous,
      lastAgentStatus: status,
    }));
  }

  /**
   * A pane's title, off the command channel.
   *
   * `POST /panes/:id/title` and an MCP/CLI `set_pane_title` call this
   * directly rather than going through a layout command: it finds the owning
   * workspace itself, so a caller does not resolve one first, and it
   * publishes — a renderer's own OSC-title write still goes through
   * `setPaneTitleFromStream`, not here, but every other source (a route, the
   * bridge) reaches every renderer the way `layout.changed` does.
   *
   * Returns false for a pane nothing owns — the route answers 400, the same
   * shape a stale paneId gets from `apply`.
   */
  setPaneTitle(paneId: string, title: string | null): boolean {
    const state = this.stateWithPane(paneId);
    if (!state) return false;
    state.paneSessions[paneId] = {
      ...(state.paneSessions[paneId] ?? emptySession(paneId)),
      lastTitle: title,
    };
    this.schedulePersist();
    this.publishPaneTitle(paneId, title);
    return true;
  }

  /**
   * What one renderer is looking at.
   *
   * Last writer wins for the **default viewport** — the answer handed to a
   * renderer that has never seen this workspace, not an authority over
   * anyone's selection.
   *
   * A detached window's report is different: it is how the window's
   * claim takes effect — the claim itself comes from main, never from the
   * report — and its viewport is not stored at all. It is one tab, and
   * handing the next renderer a workspace of one tab is exactly the bug
   * claims exist to avoid. A bridge socket never holds a claim.
   */
  reportViewport(
    workspacePath: string,
    origin: LayoutOrigin,
    viewport: WorkspaceViewport,
  ): void {
    if (origin.kind === "window") {
      const claim = this.windows.claimOf(origin.id);
      if (claim) {
        this.setClaim(origin.id, claim.workspacePath, claim.tabId, origin);
        return;
      }
      this.windowViewports.set(workspacePath, viewport);
      if (this.windows.isPrimary(origin.id)) {
        this.primaryViewports.set(workspacePath, viewport);
      }
    }
    const state = this.entries.get(workspacePath);
    if (!state) return;
    state.defaultViewport = viewport;
    this.schedulePersist();
  }

  /**
   * The primary window's view of a workspace, for the MCP snapshot.
   *
   * The primary's own report, because that is what `list_panes` means by "the
   * focused pane" — not a browser's selection and not a popout's one tab. The
   * most recent window report stands in while main has not named a primary
   * (or no window is one), and null means no window has reported at all, so
   * the caller falls back to the default viewport.
   */
  primaryViewport(workspacePath: string): WorkspaceViewport | null {
    return (
      this.primaryViewports.get(workspacePath) ??
      this.windowViewports.get(workspacePath) ??
      null
    );
  }

  /** Tabs of one workspace held by a window of their own. */
  claimsFor(workspacePath: string): LayoutClaim[] {
    const claims: LayoutClaim[] = [];
    for (const [windowId, claim] of this.claims) {
      if (claim.workspacePath === workspacePath) {
        claims.push({ windowId, tabId: claim.tabId });
      }
    }
    return claims;
  }

  /**
   * Told when a window's claim moves on a workspace this store does not hold
   * — a remote host's, whose layout is its server's. The claim
   * is still kept here (`claimsFor`); whoever publishes that workspace's
   * layout says it again. Returns the unsubscribe.
   */
  onForeignClaims(listener: (workspacePath: string, origin: LayoutOrigin) => void): () => void {
    this.foreignClaimListeners.add(listener);
    return () => {
      this.foreignClaimListeners.delete(listener);
    };
  }

  /**
   * A window is gone: whatever it held comes back to the primary.
   *
   * Called when the window's bridge connection drops
   * (`BridgeServer.onDisconnect`, wired in `app-lifecycle.ts`) — a claim that
   * outlives its window is a tab nobody can see, which is the one failure
   * mode this design has.
   */
  releaseWindow(rendererId: string): void {
    this.setClaim(rendererId, null, undefined, {
      kind: "window",
      id: rendererId,
    });
  }

  /**
   * Write any pending change now, and end every session still inside its
   * grace. Called from `before-quit`: nobody can reopen a pane after this, so
   * a shell left warm is an orphan.
   */
  flush(): void {
    this.runPendingKills();
    this.persistNow();
  }

  // ───────────────────────────── internals ──────────────────────────────

  /**
   * Record, move or release one window's claim, and tell everybody.
   *
   * Exclusive: a second window claiming a tab evicts the first, which is
   * today's behaviour when a tab is torn off twice — the loser sees a
   * `layout.changed` whose `claims` no longer name it and closes itself. The
   * broadcast goes out at the *unchanged* version, because a claim is not
   * structure and inventing a version for it would make every renderer think
   * the tree moved.
   *
   * `workspacePath` is null for a release, where the claim itself says which
   * workspace has to hear about it.
   */
  private setClaim(
    windowId: string,
    workspacePath: string | null,
    tabId: string | undefined,
    origin: LayoutOrigin,
  ): void {
    const held = this.claims.get(windowId);
    const affected = new Set<string>();

    if (tabId === undefined || workspacePath === null) {
      if (!held) return;
      this.claims.delete(windowId);
      affected.add(held.workspacePath);
    } else {
      if (held?.workspacePath === workspacePath && held.tabId === tabId) return;
      if (held) affected.add(held.workspacePath);
      for (const [otherId, other] of [...this.claims]) {
        if (
          otherId !== windowId &&
          other.workspacePath === workspacePath &&
          other.tabId === tabId
        ) {
          this.claims.delete(otherId);
        }
      }
      this.claims.set(windowId, { workspacePath, tabId });
      affected.add(workspacePath);
    }

    for (const path of affected) this.broadcastClaims(path, origin);
  }

  /**
   * Claims of a workspace, out to every renderer, at the version it is at.
   *
   * No hint and no `restored`: nothing structural happened, and the one thing
   * this broadcast says that the last one did not is who is holding what.
   */
  private broadcastClaims(workspacePath: string, origin: LayoutOrigin): void {
    const state = this.entries.get(workspacePath);
    if (!state) {
      for (const listener of this.foreignClaimListeners) listener(workspacePath, origin);
      return;
    }
    this.broadcast({
      workspacePath,
      version: state.version,
      layout: state.layout,
      claims: this.claimsFor(workspacePath),
      origin,
    });
  }

  /**
   * Drop the claims on tabs that just left the tree.
   *
   * Told by difference rather than by looking the tab up: a claim on a tab
   * that does not exist *yet* is normal — "move pane to new window" sends
   * `extract-pane-to-tab` and spawns the window in the same breath — and only
   * a tab that was there a moment ago and is gone now is a claim to release.
   */
  private dropClaimsOnGoneTabs(
    workspacePath: string,
    before: WorkspaceLayout,
    after: WorkspaceLayout,
  ): boolean {
    return this.dropClaims(workspacePath, before, after);
  }

  /**
   * Drop the claims on a remote workspace's tabs that left.
   * `after` null means the workspace was removed: every claim for the key
   * goes. With no `before`, nothing is dropped. Doesn't broadcast: the layout
   * publish that follows carries the claims.
   */
  dropForeignClaims(
    key: string,
    before: WorkspaceLayout | undefined,
    after: WorkspaceLayout | null,
  ): boolean {
    if (after === null) return this.dropClaims(key, null, null);
    if (!before) return false;
    return this.dropClaims(key, before, after);
  }

  /** The shared tab-difference rule; `after` null drops every claim. */
  private dropClaims(
    workspacePath: string,
    before: WorkspaceLayout | null,
    after: WorkspaceLayout | null,
  ): boolean {
    const had = before ? layoutTabIds(before) : null;
    const has = after ? layoutTabIds(after) : null;
    let dropped = false;
    for (const [windowId, claim] of [...this.claims]) {
      if (claim.workspacePath !== workspacePath) continue;
      if (has && (!had || !had.has(claim.tabId) || has.has(claim.tabId))) continue;
      this.claims.delete(windowId);
      dropped = true;
    }
    return dropped;
  }

  private async applyNow(
    workspacePath: string,
    command: LayoutCommand,
    origin: LayoutOrigin,
    remember: boolean,
  ): Promise<LayoutApplyResult> {
    if (
      !command ||
      typeof command !== "object" ||
      !isLayoutCommandType(command.type)
    ) {
      return {
        error: `unknown layout command from ${origin.kind} ${origin.id}: ${
          (command as { type?: string } | null)?.type ?? typeof command
        }`,
      };
    }

    const state = this.ensureState(workspacePath);
    const before = state.layout;

    const result = applyLayoutCommand(
      { layout: before, closedStack: state.closedStack },
      command,
    );
    state.closedStack = remember
      ? titleClosedPane(state, result.closedStack)
      : state.closedStack;
    // What the command implies about the *sender's* selection, to travel back
    // with the broadcast — and in the answer, for a command that changed
    // nothing and so broadcasts nothing.
    const { hint } = result;

    if (result.layout === before) {
      // A command naming an id that is not in the tree is a no-op, not an
      // error — a stale command from a slow renderer is normal.
      return { version: state.version, addedPaneIds: [], ...(hint && { hint }) };
    }

    state.layout = result.layout;
    state.version += 1;
    this.lastActiveWorkspacePath = workspacePath;

    const had = layoutPaneIds(before);
    const addedPaneIds = [...layoutPaneIds(state.layout)].filter(
      (paneId) => !had.has(paneId),
    );

    // A reopen takes its panes back off death row: whatever is still warm is
    // reattached rather than respawned, and what the server knows about those
    // panes rides along on the broadcast so they mount with it.
    const restored =
      command.type === "reopen-closed-pane"
        ? this.reclaim(state, addedPaneIds)
        : undefined;

    // A launch starts here, not in whichever renderer mounts the pane first.
    // Before the broadcast: the spawn is then in flight when a
    // renderer's `pty.create` for the pane arrives, which waits for it and
    // attaches. A reopened pane's command was cleared when it closed.
    for (const paneId of addedPaneIds) {
      if (this.pendingCommands.launchesOnApply(paneId)) {
        this.launcher.launch(workspacePath, paneId);
      }
    }

    // Ending sessions is the server's job now: the renderer sends the
    // command after its confirmation dialog, and the effect lands here. Not
    // at once, though — a terminal pane's shell stays warm for the grace, so
    // "reopen closed pane" is a real undo (see REOPEN_GRACE_MS).
    this.endPanes(workspacePath, state, before, result.killPanes, {
      grace: true,
    });

    // A tab that left the tree takes its claim with it: the window holding it
    // has nothing to show and closes itself when this broadcast lands.
    this.dropClaimsOnGoneTabs(workspacePath, before, state.layout);

    this.schedulePersist();
    this.broadcast({
      workspacePath,
      version: state.version,
      layout: state.layout,
      claims: this.claimsFor(workspacePath),
      origin,
      ...(hint && { hint }),
      ...(restored && { restored }),
    });

    return { version: state.version, addedPaneIds, ...(hint && { hint }) };
  }

  /** {@link moveToWorkspace}'s step, run in both queues: both layouts at once. */
  private moveNow(
    from: string,
    target: LayoutTarget,
    to: string,
    origin: LayoutOrigin,
    newTabId: string,
  ): WorkspaceMoveResult {
    const unknown =
      "paneId" in target
        ? `Unknown paneId: ${target.paneId}`
        : `Unknown tabId: ${target.tabId}`;
    const source = this.entries.get(from);
    const taken =
      source &&
      sendTab(
        { layout: source.layout, closedStack: source.closedStack },
        target,
        newTabId,
      );
    if (!source || !taken) return { error: unknown };
    // A workspace of the project that has never had a layout gets one now —
    // but only once the tab is sure to land in it.
    const dest = this.entries.get(to) ?? this.emptyState();
    const received = receiveTab(
      { layout: dest.layout, closedStack: dest.closedStack },
      taken.sent,
      this.activePanelOf(to, dest),
    );
    if (!received?.hint) {
      return { error: `Can't add tab ${taken.sent.tab.id} to ${to}` };
    }

    const before = source.layout;
    source.layout = taken.result.layout;
    source.version += 1;
    dest.layout = received.layout;
    dest.version += 1;
    this.entries.set(to, dest);
    this.lastActiveWorkspacePath = to;

    const moved = allPaneIds(taken.sent.tab.rootNode);
    // What the server knows about the moved panes rides on the target's
    // broadcast, as a reopen's does: a renderer forgets a pane's cwd, title
    // and status when it leaves the source, and this hands them back.
    const restored: Record<string, PersistedPaneSession> = {};
    for (const paneId of moved) {
      const session = source.paneSessions[paneId];
      if (session) {
        dest.paneSessions[paneId] = session;
        restored[paneId] = session;
        delete source.paneSessions[paneId];
      }
      const kill = this.pendingKills.get(paneId);
      if (kill) kill.workspacePath = to;
    }
    // The claim on a tab that left goes, as on a close: the detached window
    // holding it closes when the broadcast lands, and the tab opens in the
    // target in the primary window.
    this.dropClaimsOnGoneTabs(from, before, source.layout);
    try {
      this.agents.moveToWorkspace?.(moved, to);
    } catch (err) {
      console.error("[layout] failed to move agents:", err);
    }

    this.schedulePersist();
    this.broadcast({
      workspacePath: from,
      version: source.version,
      layout: source.layout,
      claims: this.claimsFor(from),
      origin,
    });
    this.broadcast({
      workspacePath: to,
      version: dest.version,
      layout: dest.layout,
      claims: this.claimsFor(to),
      origin,
      hint: received.hint,
      ...(Object.keys(restored).length > 0 && { restored }),
    });
    return {
      workspacePath: to,
      tabId: taken.sent.tab.id,
      paneId: taken.sent.focusPaneId,
      version: dest.version,
      hint: received.hint,
    };
  }

  /**
   * The panel a tab moved into `workspacePath` lands in: the primary
   * window's active panel, else the last window report's, else the default
   * viewport's. The reducer falls back to the first panel for one the
   * layout lacks.
   */
  private activePanelOf(
    workspacePath: string,
    state: WorkspaceState,
  ): string | undefined {
    const viewport =
      this.primaryViewport(workspacePath) ?? state.defaultViewport;
    return viewport?.activePanelId ?? undefined;
  }

  /**
   * Panes a reopen just put back, cancelling the kills they were waiting out.
   *
   * Told structurally — every pane the command added to the tree — so it
   * covers a reopened *tab* (many panes) and a reopened pane alike, without a
   * second reading of the reducer's stack entry. A pane whose session is
   * already gone (grace elapsed, or the daemon lost it) simply contributes
   * nothing, and the renderer mounts it fresh.
   */
  private reclaim(
    state: WorkspaceState,
    addedPaneIds: string[],
  ): Record<string, PersistedPaneSession> | undefined {
    const restored: Record<string, PersistedPaneSession> = {};
    for (const paneId of addedPaneIds) {
      this.cancelKill(paneId);
      const session = state.paneSessions[paneId];
      if (session) restored[paneId] = session;
    }
    return Object.keys(restored).length > 0 ? restored : undefined;
  }

  /**
   * Panes that left `layout`, ended: every close path and `remove` land here.
   *
   * Agents first, while `paneSessions` still has the title to name one by.
   * Then each pane's queued command goes — a pane that never mounted can
   * still be closed, by another window or by the CLI — and a terminal's shell
   * is killed, after the reopen grace or, for `remove`, now. A pane that is
   * not a terminal has no shell, only a session row.
   */
  private endPanes(
    workspacePath: string,
    state: WorkspaceState,
    layout: WorkspaceLayout,
    paneIds: readonly string[],
    { grace }: { grace: boolean },
  ): void {
    if (paneIds.length === 0) return;
    this.agents.abandonForPanes(
      paneIds.map((paneId) => ({
        paneId,
        title: state.paneSessions[paneId]?.lastTitle ?? null,
      })),
    );
    for (const paneId of paneIds) {
      this.pendingCommands.clear(paneId);
      if (contentTypeOf(layout, paneId) !== "terminal") {
        delete state.paneSessions[paneId];
        continue;
      }
      if (grace) {
        this.scheduleKill(workspacePath, paneId);
      } else {
        this.cancelKill(paneId);
        void this.killNow(workspacePath, paneId);
      }
    }
  }

  /** End this pane's session once the reopen window closes, not before. */
  private scheduleKill(workspacePath: string, paneId: string): void {
    this.cancelKill(paneId);
    const timer = setTimeout(() => {
      this.pendingKills.delete(paneId);
      void this.killNow(workspacePath, paneId);
    }, REOPEN_GRACE_MS);
    timer.unref?.();
    this.pendingKills.set(paneId, { workspacePath, timer });
  }

  private cancelKill(paneId: string): void {
    const pending = this.pendingKills.get(paneId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingKills.delete(paneId);
  }

  /** Run every pending kill, or only one workspace's. */
  private runPendingKills(onlyWorkspace?: string): void {
    const pending = [...this.pendingKills].filter(
      ([, kill]) =>
        onlyWorkspace === undefined || kill.workspacePath === onlyWorkspace,
    );
    for (const [paneId, { workspacePath, timer }] of pending) {
      this.pendingKills.delete(paneId);
      clearTimeout(timer);
      void this.killNow(workspacePath, paneId);
    }
  }

  private async killNow(workspacePath: string, paneId: string): Promise<void> {
    // The session outlived the pane on purpose; now that it is going, the
    // row goes with it. Not persisted either way — the file only holds the
    // sessions of panes that are in a tree.
    const state = this.entries.get(workspacePath);
    if (state && !findPanelWithPane(state.layout, paneId)) {
      delete state.paneSessions[paneId];
    }
    try {
      await this.backend.pty.kill(paneId);
    } catch (err) {
      console.error(`[layout] failed to kill pane ${paneId}:`, err);
    }
  }

  /**
   * The workspace's state, creating an empty single-panel layout the first
   * time the server hears of it. The panel id is minted here because no
   * command carried one — every id in a *command* comes from its sender.
   */
  private ensureState(workspacePath: string): WorkspaceState {
    const existing = this.entries.get(workspacePath);
    if (existing) return existing;
    const state = this.emptyState();
    this.entries.set(workspacePath, state);
    return state;
  }

  /** A workspace's state before its first command: one empty panel. */
  private emptyState(): WorkspaceState {
    const panelId = `panel-${crypto.randomUUID()}`;
    return {
      version: this.versionBase,
      layout: createSinglePanelLayout(panelId, [], []),
      defaultViewport: {
        activePanelId: panelId,
        selectedTabIds: {},
        focusedPaneIds: {},
      },
      paneSessions: {},
      closedStack: [],
    };
  }

  private find(
    target: LayoutTarget,
  ): { workspacePath: string; state: WorkspaceState } | null {
    for (const [workspacePath, state] of this.entries) {
      const found =
        "paneId" in target
          ? findPanelWithPane(state.layout, target.paneId)
          : findPanelWithTab(state.layout, target.tabId);
      if (found) return { workspacePath, state };
    }
    return null;
  }

  private stateWithPane(paneId: string): WorkspaceState | null {
    return this.find({ paneId })?.state ?? null;
  }

  /** Fold one change into a pane's session row, if any tree holds the pane. */
  private updateSession(
    paneId: string,
    update: (previous: PersistedPaneSession) => PersistedPaneSession,
  ): void {
    const state = this.stateWithPane(paneId);
    if (!state) return;
    const previous = state.paneSessions[paneId] ?? emptySession(paneId);
    const next = update(previous);
    if (next === previous && state.paneSessions[paneId]) return;
    state.paneSessions[paneId] = next;
    this.schedulePersist();
  }

  /**
   * Told after every debounced write of the layout file — the cadence the
   * host server pushes ride. Returns the unsubscribe.
   */
  onPersisted(listener: () => void): () => void {
    this.persistListeners.add(listener);
    return () => {
      this.persistListeners.delete(listener);
    };
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
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
    this.notifyPersisted();
  }

  private notifyPersisted(): void {
    for (const listener of [...this.persistListeners]) {
      try {
        listener();
      } catch (err) {
        console.error("[layout] persist listener threw:", err);
      }
    }
  }

  private toPersisted(): PersistedLayout {
    const workspaces: PersistedWorkspace[] = [];
    for (const [workspacePath, state] of this.entries) {
      // No focus fields in the tree: the selection lives
      // in `defaultViewport` and in each renderer's own file. An older file
      // still loads — the fields are optional and simply ignored — and is
      // rewritten clean the first time this runs.
      workspaces.push({
        workspacePath: workspacePath as WorkspaceKey,
        panelTree: state.layout.panelTree,
        panels: persistedPanels(state),
        defaultViewport: state.defaultViewport,
      });
    }
    return {
      // Still bare paths until the key migration has run: saying
      // so keeps the migration alive for next launch.
      version: this.keyed ? LAYOUT_VERSION : 2,
      workspaces,
      lastActiveWorkspacePath: this.lastActiveWorkspacePath,
    };
  }
}

/**
 * Why a move between two workspace keys is refused on the keys alone, or
 * null. Projects are `WorkspaceMoveCheck`'s.
 */
function moveRefusal(from: string, to: string): string | null {
  if (isHomePath(from) || isHomePath(to)) return "The Dashboard can't host panes";
  if (from === to) return `Already in workspace ${parseWorkspaceKey(to).path}`;
  return crossHostMoveRefusal(from, to);
}

// ──────────────────────────── shape conversion ────────────────────────────

/**
 * One workspace as a reader sees it.
 *
 * `paneSessions` is filtered to the panes the tree actually holds: a pane
 * closed inside the reopen grace keeps its row in memory — that is what makes
 * `restored` possible — but no tree holds it, and handing it to a renderer
 * would seed side maps for a pane that will never mount.
 */
function snapshot(
  state: WorkspaceState,
  claims: LayoutClaim[],
): LayoutEntry {
  const alive = layoutPaneIds(state.layout);
  const paneSessions: Record<string, PersistedPaneSession> = {};
  for (const [paneId, session] of Object.entries(state.paneSessions)) {
    if (alive.has(paneId)) paneSessions[paneId] = session;
  }
  return {
    version: state.version,
    layout: state.layout,
    defaultViewport: state.defaultViewport,
    paneSessions,
    claims,
  };
}

function emptySession(paneId: string): PersistedPaneSession {
  // `daemonSessionId === paneId` — see `ptyCreate` in `electron/ipc/pty.ts`.
  return { daemonSessionId: paneId, lastCwd: null, lastTitle: null };
}

/**
 * A closed pane's terminal title, onto the reopen stack entry the command
 * just pushed.
 *
 * The reducer keeps the pane's leaf — its url and content type are in the
 * tree — but a title is server-derived `paneSessions` state it never sees,
 * and it is what a pane reopened into a tab of its own is named.
 */
function titleClosedPane(
  state: WorkspaceState,
  stack: ClosedPane[],
): ClosedPane[] {
  const head = stack[0];
  if (stack === state.closedStack || head?.kind !== "pane") return stack;
  const title = state.paneSessions[head.leaf.paneId]?.lastTitle;
  return title ? [{ ...head, title }, ...stack.slice(1)] : stack;
}

/** What a pane renders, read off the tree; a pane it lacks is a terminal. */
function contentTypeOf(layout: WorkspaceLayout, paneId: string): string {
  const found = findPanelWithPane(layout, paneId);
  const leaf = found && findLeaf(found.tab.rootNode, paneId);
  return leaf?.contentType ?? "terminal";
}

/** Structure only: a v2 or early-v3 file's focus fields are read out into
 *  `defaultViewport` by the migration and dropped here. */
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
        }),
      ),
      pinnedTabIds: panel.pinnedTabIds,
    };
  }
  return { panelTree: workspace.panelTree, panels };
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
          paneSessions,
        };
      }),
      pinnedTabIds: panel.pinnedTabIds,
    };
  }
  return panels;
}
