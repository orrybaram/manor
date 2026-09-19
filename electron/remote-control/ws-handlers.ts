/**
 * What `ns.method` means on the ADR-178 bridge (D8).
 *
 * A flat table of plain functions over `IpcDeps` — the same deps object the
 * `electron/ipc/*` modules get, because inventing a second one would be the
 * start of a second drift. Each entry calls a function *lifted out of* an
 * `ipcMain.handle` wrapper, never `ipcMain` itself: dispatching reflectively
 * into Electron's private handler map would silently hand a browser every
 * method any module ever registered, including `webview:*` and the dialog
 * calls, and the whole point of a table is that what is absent from it cannot
 * be reached. The lifted functions keep their `assert*` validation, and both
 * callers go through it.
 *
 * Slice 1 is deliberately small: the reads the sidebar and the stores make on
 * mount, the PTY calls a live terminal makes, and two selection writes.
 * Everything else answers `unavailable:web` — an honest refusal the renderer
 * can render an empty state from, rather than a hang or a silent no-op.
 *
 * Adding a *write* here is a security decision, not a convenience one. A
 * `full` device already reaches the whole HTTP route table (D3), so nothing
 * here is a new grant of power — but every method in this table is one more
 * thing a stolen `full` token can do without an audit line unless it is also
 * named in `MUTATING`.
 */

import {
  ptyCreate,
  ptyWrite,
  ptyResize,
  ptyReset,
  ptyClose,
  ptyDetach,
} from "../ipc/pty";
import { isDesktopAttached } from "../pty-attachments";
import { layoutLoad, layoutGetRestoredSessions } from "../ipc/layout";
import {
  projectsGetAll,
  projectsGetSelectedIndex,
  projectsSelect,
  projectsSelectWorkspace,
} from "../ipc/projects";
import {
  themeGet,
  themeGetSelectedName,
  themeHasGhosttyConfig,
  themePreview,
  themeAllColors,
} from "../ipc/theme";
import {
  agentsGetAll,
  agentsGet,
  agentsGetActive,
  agentsGetRecent,
  agentsGetUnseen,
  agentsBuildResumeCommand,
  type AgentQuery,
} from "../ipc/agents";
import {
  preferencesGetAll,
  preferencesSet,
  keybindingsGetAll,
} from "../ipc/misc";
import { remoteControlGetStatus } from "../ipc/remote-control";
import { statsGetSummary } from "../ipc/stats";
import { notificationsGetAll } from "../ipc/notifications";
import { processesList } from "../ipc/processes";
import type { IpcDeps } from "../ipc/types";

/**
 * The `code` on a rejected result frame for anything the bridge does not do.
 * The client turns it into `BridgeUnavailableError` (ticket 4), which the
 * renderer renders as a stated empty state.
 */
export const UNAVAILABLE_CODE = "unavailable:web";

/**
 * A handler the bridge may call.
 *
 * `never[]` rather than `unknown[]`: the entries below declare the argument
 * types they actually want, and parameter contravariance makes each of them
 * assignable to this. The bridge widens it back to `unknown[]` at the single
 * call site, where the arguments really are whatever JSON arrived — which is
 * exactly why every entry runs the `assert*` validation the desktop path runs.
 */
export type BridgeHandler = (deps: IpcDeps, ...args: never[]) => unknown;

/**
 * A method that is in the table on purpose and refuses on purpose.
 *
 * Refusing beats silently dropping: a browser that calls `layout.save` and
 * gets nothing back has quietly lost the user's arrangement, while one that
 * gets this can say so. Layout stays renderer-owned until ADR-178 slice 2
 * flips it to the Manor server (D6).
 */
export class BridgeRefusal extends Error {
  readonly code = UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = "BridgeRefusal";
  }
}

/** What a create-shaped call tells the browser about the winsize (D5). */
export interface WinsizeDecoration {
  /** False when a desktop window has this pane mounted: follow, do not fit. */
  winsizeOwner: boolean;
  /** The grid to render — the owner's, not the one the browser asked for. */
  cols: number;
  rows: number;
}

/**
 * The session's current grid, or null if the daemon has no opinion yet.
 *
 * Never throws: a browser that cannot be told the owner's size is better off
 * with the size it asked for than with a failed `pty.create`.
 */
async function sessionGrid(
  deps: IpcDeps,
  paneId: string,
): Promise<{ cols: number; rows: number } | null> {
  try {
    const snapshot = await deps.backend.pty.getSnapshot(paneId);
    if (!snapshot?.cols || !snapshot.rows) return null;
    return { cols: snapshot.cols, rows: snapshot.rows };
  } catch {
    return null;
  }
}

/**
 * Run a create-shaped call for a *web* viewer and say who owns the winsize.
 *
 * Two things happen here that do not happen on the desktop path, and both are
 * D5. First, when the desktop holds the pane the browser's own `cols×rows` is
 * dropped before the call: `createOrAttach` resizes the session before it
 * snapshots it (see `terminal-host/client.ts`), so passing the browser's grid
 * through would resize the desktop's pane as a side effect of merely looking at
 * it — the exact bug ADR-163/164/165 are about, arriving through the one door
 * marked "read". Second, the answer carries the owner's grid, which is what the
 * follower renders.
 *
 * Decoration happens here and nowhere else. The desktop's `ipcMain.handle`
 * keeps the shape it has always returned; `winsizeOwner` absent means owner.
 */
async function createShaped<T extends { ok: boolean }>(
  deps: IpcDeps,
  paneId: string,
  cols: number,
  rows: number,
  run: (cols: number, rows: number) => Promise<T>,
): Promise<T | (T & WinsizeDecoration)> {
  const follower = isDesktopAttached(paneId);
  const owner = follower ? await sessionGrid(deps, paneId) : null;
  const grid = owner ?? { cols, rows };
  const result = await run(grid.cols, grid.rows);
  if (!result.ok) return result;
  return {
    ...result,
    winsizeOwner: !follower,
    cols: grid.cols,
    rows: grid.rows,
  };
}

export const WS_HANDLERS: Record<string, BridgeHandler> = {
  // ── pty: the terminal itself ──
  // `create` and `reset` answer with who owns the winsize; `resize` is a no-op
  // while the desktop does (ADR-178 D5).
  "pty.create": (
    deps: IpcDeps,
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
    agentKind?: string | null,
  ) =>
    createShaped(deps, paneId, cols, rows, (c, r) =>
      ptyCreate(deps, paneId, cwd, c, r, agentKind),
    ),
  /**
   * Create-shaped, and reachable from the pane menu — so it is on the table,
   * decorated exactly as `create` is. `pty.consumePrewarmed` is not: a prewarmed
   * session belongs to the window that asked for one.
   */
  "pty.reset": (
    deps: IpcDeps,
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
  ) =>
    createShaped(deps, paneId, cols, rows, (c, r) =>
      ptyReset(deps, paneId, cwd, c, r),
    ),
  "pty.write": (deps: IpcDeps, paneId: string, data: string) =>
    ptyWrite(deps, paneId, data),
  /**
   * A follower asking for a size is not an error, and it is not a resize.
   *
   * It is answered rather than refused because refusing is a rejected promise
   * on every layout tick, which `useTerminalResize` would log; and it is
   * dropped rather than forwarded because the desktop's grid is not the
   * browser's to move. A browser that is the *only* viewer resizes normally —
   * it is the winsize owner then.
   */
  "pty.resize": (deps: IpcDeps, paneId: string, cols: number, rows: number) => {
    if (isDesktopAttached(paneId)) return;
    return ptyResize(deps, paneId, cols, rows);
  },
  "pty.close": (deps: IpcDeps, paneId: string) => ptyClose(deps, paneId),
  "pty.detach": (deps: IpcDeps, paneId: string) => ptyDetach(deps, paneId),

  // ── layout: read now, write in slice 2 ──
  "layout.load": (deps: IpcDeps) => layoutLoad(deps),
  "layout.getRestoredSessions": (deps: IpcDeps) =>
    layoutGetRestoredSessions(deps),
  "layout.save": () => {
    throw new BridgeRefusal(
      "Layout changes are not saved from the browser yet (ADR-178, slice 2)",
    );
  },

  // ── projects: the sidebar's reads, plus the two selection writes ──
  "projects.getAll": (deps: IpcDeps) => projectsGetAll(deps),
  "projects.getSelectedIndex": (deps: IpcDeps) => projectsGetSelectedIndex(deps),
  "projects.select": (deps: IpcDeps, index: number) =>
    projectsSelect(deps, index),
  "projects.selectWorkspace": (
    deps: IpcDeps,
    projectId: string,
    workspaceIndex: number,
  ) => projectsSelectWorkspace(deps, projectId, workspaceIndex),

  // ── theme, preferences, keybindings: what the stores read on mount ──
  "theme.get": (deps: IpcDeps) => themeGet(deps),
  "theme.getSelectedName": (deps: IpcDeps) => themeGetSelectedName(deps),
  "theme.hasGhosttyConfig": (deps: IpcDeps) => themeHasGhosttyConfig(deps),
  "theme.preview": (deps: IpcDeps, name: string) => themePreview(deps, name),
  "theme.allColors": (deps: IpcDeps) => themeAllColors(deps),
  "preferences.getAll": (deps: IpcDeps) => preferencesGetAll(deps),
  /**
   * A `full` device may write preferences (D3); the reason this was off the
   * slice-1 table was scope, not policy. `keybindings.set`/`reset`/`resetAll`
   * stay off — ticket 6 made that page read-only on web — and are absent on
   * purpose, not merely unimplemented.
   */
  "preferences.set": (deps: IpcDeps, key: string, value: unknown) =>
    preferencesSet(deps, key, value),
  "keybindings.getAll": (deps: IpcDeps) => keybindingsGetAll(deps),

  // ── remoteControl: the one read, so the settings page isn't lying to the
  // device that let it in. setEnabled/pair/revoke/tunnel stay off — read-only
  // on web (ticket 6) ──
  "remoteControl.getStatus": (deps: IpcDeps) => remoteControlGetStatus(deps),

  // ── agents: reads only ──
  "agents.getAll": (deps: IpcDeps, opts?: AgentQuery) =>
    agentsGetAll(deps, opts),
  "agents.get": (deps: IpcDeps, agentId: string) => agentsGet(deps, agentId),
  "agents.getActive": (deps: IpcDeps) => agentsGetActive(deps),
  "agents.getRecent": (deps: IpcDeps, opts?: { limit?: number }) =>
    agentsGetRecent(deps, opts),
  "agents.getUnseen": () => agentsGetUnseen(),
  "agents.buildResumeCommand": (deps: IpcDeps, agentId: string) =>
    agentsBuildResumeCommand(deps, agentId),

  // ── the two logs the chrome reads on mount ──
  "notifications.getAll": (deps: IpcDeps) => notificationsGetAll(deps),
  "stats.getSummary": (deps: IpcDeps) => statsGetSummary(deps),

  // ── daemon status. The rest of `processes.*` kills things; it is absent. ──
  "processes.list": (deps: IpcDeps) => processesList(deps),
};

/**
 * Which invokes leave an audit line.
 *
 * `pty.write` is not here, and that is the one exclusion worth arguing about:
 * it is the keyboard. ADR-161 chose to audit *sends* — a whole prompt handed
 * to an agent through `POST /sessions/send` — and not keystrokes, because a
 * line per character is not a trail, it is a keylogger with a rotation policy.
 * `pty.resize` and `pty.detach` are out for the same reason: they are what a
 * viewer does to its own view.
 *
 * What is in: anything that starts or ends a session, and anything that moves
 * state the *other* viewers of this host will see.
 */
export const MUTATING: ReadonlySet<string> = new Set([
  "pty.create",
  "pty.reset",
  "pty.close",
  "projects.select",
  "projects.selectWorkspace",
  "preferences.set",
]);
