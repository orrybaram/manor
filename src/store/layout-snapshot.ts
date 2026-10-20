/**
 * How a set of the server's workspaces lands in this renderer's replica.
 *
 * Pure: every function here takes the store's state and answers the patch to
 * write, so a broadcast, the boot read and a resync all merge the same way.
 * What reaches outside the store — closing a popout, forgetting a remote
 * pane — stays with the caller in `app-store.ts`.
 */
import type { AppState } from "./app-store";
import {
  type WorkspaceViewport,
  EMPTY_VIEWPORT,
  emptyViewport,
  reconcileViewport,
} from "../lib/layout/viewport";
import {
  type LayoutClaim,
  type Visibility,
  sameClaims,
} from "../lib/layout/visible-tabs";
import {
  type WorkspaceLayout,
  layoutPaneIds,
} from "../lib/layout/workspace-layout";
import type {
  LayoutEntry,
  PaneAgentStatus,
  PersistedPaneSession,
} from "../electron.d";

/** What decides which tabs of `path` this renderer shows, given the claims. */
export type VisibilityOf = (
  state: Partial<Pick<AppState, "claims">>,
  path: string,
) => Visibility;

/**
 * What the server derived about a set of panes, as this store's side maps.
 *
 * The same shape arrives by two roads — a snapshot's `paneSessions`, and a
 * reopen's `restored` — so both seed through here. Only a reopen seeds the
 * agent status, and as a prime only: `agents:getPaneStatuses` (at boot and on
 * a resync) and the live `agents.onStatus` stream are what decide it.
 */
export function sessionSideMaps(
  sessions: Record<string, PersistedPaneSession>,
): {
  cwds: Record<string, string>;
  titles: Record<string, string>;
  agents: Record<string, PaneAgentStatus>;
} {
  const cwds: Record<string, string> = {};
  const titles: Record<string, string> = {};
  const agents: Record<string, PaneAgentStatus> = {};
  for (const [paneId, session] of Object.entries(sessions)) {
    if (session.lastCwd) cwds[paneId] = session.lastCwd;
    if (session.lastTitle) titles[paneId] = session.lastTitle;
    // The Status reconciler's shape; a renderer reads only
    // `status` and `kind` back out of what an older file kept.
    const agent = session.lastAgentStatus;
    if (agent) agents[paneId] = agent as PaneAgentStatus;
  }
  return { cwds, titles, agents };
}

/**
 * The per-pane side maps without `paneIds`: what this renderer heard about
 * panes that have left every tree. Their sessions are the server's to end.
 */
export function withoutPanes(
  state: AppState,
  paneIds: Iterable<string>,
): Partial<AppState> {
  const paneCwd = { ...state.paneCwd };
  const paneTitle = { ...state.paneTitle };
  const paneAgentStatus = { ...state.paneAgentStatus };
  const paneFavicon = { ...state.paneFavicon };
  const paneLiveUrl = { ...state.paneLiveUrl };
  const panePickedElement = { ...state.panePickedElement };
  for (const paneId of paneIds) {
    delete paneCwd[paneId];
    delete paneTitle[paneId];
    delete paneAgentStatus[paneId];
    delete paneFavicon[paneId];
    delete paneLiveUrl[paneId];
    delete panePickedElement[paneId];
  }
  return {
    paneCwd,
    paneTitle,
    paneAgentStatus,
    paneFavicon,
    paneLiveUrl,
    panePickedElement,
  };
}

/**
 * Forget this renderer's copy of a workspace: its layout, the version and
 * claims it was at, its viewport, and the side maps of every pane in it.
 * What a `removed` broadcast does, and a snapshot that no longer lists it.
 */
export function withoutWorkspace(
  state: AppState,
  workspacePath: string,
): Partial<AppState> {
  const { [workspacePath]: removed, ...workspaceLayouts } =
    state.workspaceLayouts;
  const { [workspacePath]: _version, ...layoutVersions } = state.layoutVersions;
  const { [workspacePath]: _mounted, ...mountedWorkspaces } =
    state.mountedWorkspaces;
  const { [workspacePath]: _claims, ...claims } = state.claims;
  const { [workspacePath]: _viewport, ...viewports } = state.viewports;
  return {
    workspaceLayouts,
    layoutVersions,
    mountedWorkspaces,
    claims,
    viewports,
    ...(removed && withoutPanes(state, layoutPaneIds(removed))),
  };
}

/** One workspace as the server holds it, at a version. */
export interface Adoption {
  workspacePath: string;
  version: number;
  layout: WorkspaceLayout;
  claims: LayoutClaim[];
}

export interface AdoptOptions {
  visibilityOf: VisibilityOf;
  /** The active workspace's key: it is mounted on adoption. */
  activeKey: string | null;
  /** This renderer's own selection hint, applied after the repair. */
  hint?: (
    layout: WorkspaceLayout,
    viewport: WorkspaceViewport,
    visibility: Visibility,
  ) => WorkspaceViewport;
}

/**
 * Replace the replica of one workspace with the server's, or null when the
 * replica is already at least as new.
 *
 * A version *below* the one held is dropped: replays and the overlap between
 * a read and the broadcasts around it are both normal. One at the **same**
 * version is not necessarily stale, though — a claim changing carries no new
 * tree, so `(version, claims)` is compared.
 *
 * Every workspace's layout is kept, opened here or not; only an opened one
 * has its viewport repaired — never replaced — because nothing else is
 * looking at it. `gone` is the panes that left the tree.
 */
export function adoptLayout(
  state: AppState,
  adoption: Adoption,
  opts: AdoptOptions,
): { patch: Partial<AppState>; gone: string[] } | null {
  const { workspacePath, version, layout, claims } = adoption;
  const held = state.layoutVersions[workspacePath] ?? 0;
  const previous = state.workspaceLayouts[workspacePath];
  if (version < held) return null;
  if (
    version === held &&
    previous !== undefined &&
    sameClaims(claims, state.claims[workspacePath] ?? [])
  ) {
    return null;
  }
  const patch: Partial<AppState> = {
    workspaceLayouts: { ...state.workspaceLayouts, [workspacePath]: layout },
    layoutVersions: { ...state.layoutVersions, [workspacePath]: version },
    claims: { ...state.claims, [workspacePath]: claims },
  };

  // Panes that left the tree take their side-map entries with them. The
  // server has already ended their sessions (`effects.killPanes`).
  let gone: string[] = [];
  if (previous) {
    const alive = layoutPaneIds(layout);
    gone = [...layoutPaneIds(previous)].filter((id) => !alive.has(id));
    if (gone.length > 0) Object.assign(patch, withoutPanes(state, gone));
  }

  const active = workspacePath === opts.activeKey;
  if (!state.mountedWorkspaces[workspacePath] && !active) return { patch, gone };
  if (active && !state.mountedWorkspaces[workspacePath]) {
    patch.mountedWorkspaces = { ...state.mountedWorkspaces, [workspacePath]: true };
  }

  // Structure is replaced wholesale; the selection is this window's and
  // survives, repaired against the tree that just arrived — and against the
  // claims, which say which of its tabs are on screen somewhere else.
  const before = state.viewports[workspacePath] ?? EMPTY_VIEWPORT;
  const visibility = opts.visibilityOf(patch, workspacePath);
  const reconciled = reconcileViewport(layout, before, visibility);
  const viewport = opts.hint
    ? opts.hint(layout, reconciled, visibility)
    : reconciled;
  if (viewport !== before) {
    patch.viewports = { ...state.viewports, [workspacePath]: viewport };
  }
  return { patch, gone };
}

export interface SnapshotOptions {
  visibilityOf: VisibilityOf;
  activeKey: string | null;
  /** `layoutVersions` as it was when the read was sent. */
  before: Record<string, number>;
  /**
   * Where a workspace this renderer holds no viewport for starts from: its
   * own saved one, else the host's default. Boot passes the
   * viewport file; a resync leaves it out, and a workspace it does not hold
   * a viewport for gets one when it is first opened (`mountPatch`). Either
   * way a viewport this renderer already holds is repaired, never replaced.
   */
  seedViewports?: Record<string, WorkspaceViewport>;
}

export interface SnapshotResult {
  /** A full state for `set` — unchanged maps keep their identity. */
  next: AppState;
  /** Workspaces whose replica was replaced. */
  adopted: string[];
  /** Panes that left a replaced tree. */
  gone: string[];
  /** Workspaces the snapshot no longer lists, dropped. */
  removed: string[];
}

/**
 * Merge a `layout.getAll()` snapshot into `state` — the boot read and a
 * bridge resync both land through here.
 *
 * Each entry is adopted like a broadcast, except one a broadcast already
 * brought to the same version while the read was in flight: that broadcast
 * is at least as new as the read. The panes of every entry not older than the
 * replica seed the cwd and title side maps, the server's winning. Agent
 * statuses are not the file's to say: `getPaneStatuses` re-reads them.
 *
 * A workspace the server no longer lists is dropped the way its `removed`
 * broadcast would drop it — unless it appeared or moved while the read was
 * in flight, which the read cannot speak for. That window is the only
 * local-only workspace there is: the store writes layouts from broadcasts
 * alone, and a workspace a command is still creating has no layout yet.
 */
export function applyLayoutSnapshot(
  state: AppState,
  entries: Record<string, LayoutEntry>,
  opts: SnapshotOptions,
): SnapshotResult {
  let next = state;
  const adopted: string[] = [];
  const gone: string[] = [];
  const cwds: Record<string, string> = {};
  const titles: Record<string, string> = {};

  for (const [workspacePath, entry] of Object.entries(entries)) {
    const held = next.layoutVersions[workspacePath];
    if (held !== undefined && held > entry.version) continue;
    const maps = sessionSideMaps(entry.paneSessions);
    Object.assign(cwds, maps.cwds);
    Object.assign(titles, maps.titles);
    // A broadcast at this very version that landed mid-read is the newer
    // word on the claims; the read only ever loses that tie.
    const tie = held === entry.version && held !== opts.before[workspacePath];
    const seedFrom = next.viewports[workspacePath]
      ? undefined
      : opts.seedViewports;
    const result = tie
      ? null
      : adoptLayout(
          next,
          {
            workspacePath,
            version: entry.version,
            layout: entry.layout,
            claims: entry.claims,
          },
          opts,
        );
    if (result) {
      next = { ...next, ...result.patch };
      adopted.push(workspacePath);
      gone.push(...result.gone);
    }

    const layout = next.workspaceLayouts[workspacePath];
    if (seedFrom && layout) {
      next = {
        ...next,
        viewports: {
          ...next.viewports,
          [workspacePath]: reconcileViewport(
            layout,
            seedFrom[workspacePath] ??
              entry.defaultViewport ??
              emptyViewport(),
            opts.visibilityOf(next, workspacePath),
          ),
        },
      };
    }
  }

  next = {
    ...next,
    paneCwd: { ...next.paneCwd, ...cwds },
    paneTitle: { ...next.paneTitle, ...titles },
  };

  const removed: string[] = [];
  for (const workspacePath of Object.keys(next.layoutVersions)) {
    if (workspacePath in entries) continue;
    const held = next.layoutVersions[workspacePath];
    if (held !== opts.before[workspacePath]) continue;
    next = { ...next, ...withoutWorkspace(next, workspacePath) };
    removed.push(workspacePath);
  }

  return { next, adopted, gone, removed };
}
