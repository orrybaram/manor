/**
 * What `ns.method` means on the bridge (ADR-178 D8, ADR-180 D1).
 *
 * One table, every caller: a paired `full` device over the WebSocket today,
 * and every Electron renderer window too once ADR-180 D2's IPC transport
 * joins them. It lives in `electron/bridge/` rather than in
 * `remote-control/` because it was never about remote control; being
 * reachable from a phone was the first use it had, not the shape of it.
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
 * Slice 1 started deliberately small — the reads the sidebar and the stores
 * make on mount, the PTY calls a live terminal makes, and two selection
 * writes — and grew as later tickets closed gaps that only showed up once a
 * browser was actually driving the app: `pty.reset` (ticket 5, so the pane
 * menu's reset action works over the bridge, decorated with a winsize exactly
 * as `pty.create` is), `preferences.set` and `remoteControl.getStatus`
 * (ticket 9, so a `full` device's own settings pages aren't lying about the
 * surface they're on), and `agents.setPaneContext` (ticket 10, so a pane
 * opened from a browser gets the same per-pane agent metadata a desktop pane
 * does). What is below is the table as it stands, not the slice-1 table
 * anymore. Everything not in it answers `unavailable:web` — an honest refusal
 * the renderer can render an empty state from, rather than a hang or a
 * silent no-op.
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
  ptyConsumePrewarmed,
  ptyUpdatePrewarmCwd,
} from "../ipc/pty";
import {
  attach,
  isDesktopAttached,
  ownerOf,
  release,
  wouldOwn,
  type Viewer,
} from "../pty-attachments";
import {
  layoutApply,
  layoutGetAll,
  layoutGetLastActive,
  layoutRemove,
  layoutReportViewport,
  layoutSetPendingCommand,
} from "../ipc/layout";
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
  agentsSetPaneContext,
  type AgentQuery,
  type PaneContext,
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
import {
  appCommandResult,
  type AppCommandResult,
} from "../renderer-bridge";
import type { IpcDeps } from "../ipc/types";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import type { PendingCommandKind } from "../layout/pending-commands";
import type { PersistedDefaultViewport } from "../terminal-host/layout-persistence";
import type { LayoutOrigin } from "../layout/layout-store";

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
 * with the size it asked for than with a failed `pty.create`. Exported for
 * `server.ts`'s ownership-change push (D6), which needs the same
 * "ask the daemon, shrug on failure" grid lookup outside of a create call.
 */
export async function sessionGrid(
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
 * The viewer a table call is from (ADR-180 D6).
 *
 * The transport appends the caller's identity to the arguments of everything
 * in `ORIGIN_ARGS`, as a `LayoutOrigin` — `window` for a renderer on this
 * machine, `bridge` for a paired device — and this is where that becomes the
 * thing `pty-attachments.ts` tracks. A frame cannot supply it: dispatch
 * overwrites the slot, so a device cannot attach as somebody else's window
 * and take the winsize with it.
 */
function viewerOf(origin: LayoutOrigin | undefined): Viewer | null {
  if (!origin) return null;
  return {
    connectionId: origin.id,
    callerClass: origin.kind === "window" ? "local" : "device",
  };
}

/**
 * Run a create-shaped call and tell the caller who owns the winsize (D5/D6).
 *
 * Two things happen here that did not happen on the old desktop path, and
 * both are why that path is gone. First, when someone who outranks this
 * caller holds the pane, the caller's own `cols×rows` is dropped before the
 * call: `createOrAttach` resizes the session before it snapshots it (see
 * `terminal-host/client.ts`), so passing a follower's grid through would
 * resize the owner's pane as a side effect of merely looking at it — the
 * exact bug ADR-163/164/165 are about, arriving through the one door marked
 * "read". Second, the answer carries the owner's grid, which is what the
 * follower renders.
 *
 * Who outranks whom is `pty-attachments.ts`'s rule and not a special case for
 * the desktop: a caller is a follower exactly when attaching would *not* make
 * it the owner (`wouldOwn`), which for a window on this machine is only when
 * it already holds the pane and let another viewer take it. What ADR-180
 * changed is that a local viewer can be that follower at all — two windows on
 * one pane used to both measure for themselves (D6).
 *
 * Decoration happens here and nowhere else; `winsizeOwner` absent means
 * owner, which is what every caller that never asked has always assumed.
 */
async function createShaped<T extends { ok: boolean }>(
  deps: IpcDeps,
  paneId: string,
  viewer: Viewer | null,
  cols: number,
  rows: number,
  run: (cols: number, rows: number) => Promise<T>,
): Promise<T | (T & WinsizeDecoration)> {
  // A caller with no identity cannot be looked up, and gets the conservative
  // answer it got before there were connections: follow whatever the machine
  // has open.
  const follower = viewer ? !wouldOwn(paneId, viewer) : isDesktopAttached(paneId);
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

export const HANDLERS: Record<string, BridgeHandler> = {
  // ── pty: the terminal itself ──
  // `create` and `reset` answer with who owns the winsize, and attach the
  // calling connection as a viewer once they succeed. Every caller comes
  // through here since ADR-180 ticket 5 — a renderer window over `bridge:*`
  // IPC and a paired device over the socket — so this is the one place a
  // pane gains a viewer, and `resize` is a no-op for anyone who is not the
  // one that owns it.
  "pty.create": async (
    deps: IpcDeps,
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
    agentKind?: string | null,
    origin?: LayoutOrigin,
  ) => {
    const viewer = viewerOf(origin);
    const result = await createShaped(deps, paneId, viewer, cols, rows, (c, r) =>
      ptyCreate(deps, paneId, cwd, c, r, agentKind),
    );
    if (result.ok && viewer) attach(paneId, viewer);
    return result;
  },
  /**
   * Create-shaped, and reachable from the pane menu — so it is on the table,
   * decorated exactly as `create` is.
   */
  "pty.reset": async (
    deps: IpcDeps,
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
    origin?: LayoutOrigin,
  ) => {
    const viewer = viewerOf(origin);
    const result = await createShaped(deps, paneId, viewer, cols, rows, (c, r) =>
      ptyReset(deps, paneId, cwd, c, r),
    );
    if (result.ok && viewer) attach(paneId, viewer);
    return result;
  },
  "pty.write": (deps: IpcDeps, paneId: string, data: string) =>
    ptyWrite(deps, paneId, data),
  /**
   * A follower asking for a size is not an error, and it is not a resize.
   *
   * It is answered rather than refused because refusing is a rejected promise
   * on every layout tick, which `useTerminalResize` would log; and it is
   * dropped rather than forwarded because it is not this caller's grid to
   * move (D6) — it belongs to another viewer, which since ADR-180 may be a
   * second window of the desktop as readily as a browser. A caller that owns
   * the pane's winsize resizes normally.
   */
  "pty.resize": (
    deps: IpcDeps,
    paneId: string,
    cols: number,
    rows: number,
    origin?: LayoutOrigin,
  ) => {
    const owner = ownerOf(paneId);
    const viewer = viewerOf(origin);
    const isOwner = !!owner && owner.connectionId === viewer?.connectionId;
    if (owner && !isOwner) return;
    return ptyResize(deps, paneId, cols, rows);
  },
  "pty.close": (deps: IpcDeps, paneId: string, origin?: LayoutOrigin) => {
    const viewer = viewerOf(origin);
    if (viewer) release(paneId, viewer);
    return ptyClose(deps, paneId);
  },
  "pty.detach": (deps: IpcDeps, paneId: string, origin?: LayoutOrigin) => {
    const viewer = viewerOf(origin);
    if (viewer) release(paneId, viewer);
    return ptyDetach(deps, paneId);
  },
  /**
   * The prewarm pair, `LOCAL_ONLY` (D4).
   *
   * There is one prewarmed session per host and its cwd tracks the primary
   * window's active workspace, so it is the window at the machine's to adopt
   * — a device consuming it would get a shell sitting somewhere else, and a
   * device *moving* it would move the desktop's out from under it.
   */
  "pty.consumePrewarmed": (deps: IpcDeps) => ptyConsumePrewarmed(deps),
  "pty.updatePrewarmCwd": (
    deps: IpcDeps,
    cwd: string,
    agentCommand?: string | null,
    agentKind?: string | null,
  ) => ptyUpdatePrewarmCwd(deps, cwd, agentCommand, agentKind),

  // ── layout: the same commands the desktop sends ──
  /**
   * ADR-179 D1: a browser arranges panes by sending the same commands the
   * desktop sends. `workspacePath` first, so the audit line's target is the
   * workspace the command moved — see `bridgeTarget`.
   */
  "layout.getAll": (deps: IpcDeps) => layoutGetAll(deps),
  "layout.getLastActive": (deps: IpcDeps) => layoutGetLastActive(deps),
  "layout.apply": (
    deps: IpcDeps,
    workspacePath: string,
    command: LayoutCommand,
    origin?: LayoutOrigin,
  ) =>
    layoutApply(
      deps,
      workspacePath,
      command,
      origin ?? { kind: "bridge", id: "web" },
    ),
  /**
   * A browser opening "a new tab running `pnpm dev`" queues the line the same
   * way the desktop does (ticket 11) — the pane it names is the server's, and
   * so is the map the line waits in.
   */
  "layout.setPendingCommand": (
    deps: IpcDeps,
    paneId: string,
    text: string,
    kind?: PendingCommandKind,
  ) => layoutSetPendingCommand(deps, paneId, text, kind),
  "layout.remove": (deps: IpcDeps, workspacePath: string) =>
    layoutRemove(deps, workspacePath),
  /**
   * A browser's viewport report, minus any `claim` it carried (ADR-179 D4).
   *
   * A claim is a *desktop window's* hold on a tab, and honouring one from a
   * socket would let a phone make a tab vanish from the desk. Stripped here
   * rather than refused, so a browser running the same renderer code as a
   * detached window still gets its selection remembered.
   */
  "layout.reportViewport": (
    deps: IpcDeps,
    workspacePath: string,
    rendererId: string,
    viewport: PersistedDefaultViewport,
    origin?: LayoutOrigin,
  ) => {
    const { claim: _claim, ...unclaimed } = viewport ?? {};
    return layoutReportViewport(
      deps,
      workspacePath,
      rendererId,
      unclaimed as PersistedDefaultViewport,
      origin,
    );
  },

  // ── projects: the sidebar's reads, plus the two selection writes ──
  "projects.getAll": (deps: IpcDeps) => projectsGetAll(deps),
  "projects.getSelectedIndex": (deps: IpcDeps) =>
    projectsGetSelectedIndex(deps),
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

  // ── agents: reads, plus the one write a pane needs to get an agent context ──
  "agents.getAll": (deps: IpcDeps, opts?: AgentQuery) =>
    agentsGetAll(deps, opts),
  "agents.get": (deps: IpcDeps, agentId: string) => agentsGet(deps, agentId),
  "agents.getActive": (deps: IpcDeps) => agentsGetActive(deps),
  "agents.getRecent": (deps: IpcDeps, opts?: { limit?: number }) =>
    agentsGetRecent(deps, opts),
  "agents.getUnseen": () => agentsGetUnseen(),
  "agents.buildResumeCommand": (deps: IpcDeps, agentId: string) =>
    agentsBuildResumeCommand(deps, agentId),
  /**
   * Called after every `pty.create` that has a `cwd` (ticket 10) — without
   * this on the table, a pane opened from a browser silently never gets the
   * project/workspace context the sidebar's per-pane agent metadata reads.
   */
  "agents.setPaneContext": (
    deps: IpcDeps,
    paneId: string,
    context: PaneContext,
  ) => agentsSetPaneContext(deps, paneId, context),

  // ── the two logs the chrome reads on mount ──
  "notifications.getAll": (deps: IpcDeps) => notificationsGetAll(deps),
  "stats.getSummary": (deps: IpcDeps) => statsGetSummary(deps),

  // ── daemon status. The rest of `processes.*` kills things; it is absent. ──
  "processes.list": (deps: IpcDeps) => processesList(deps),

  /**
   * The renderer answering an `appCommands.command` that carried a
   * `requestId` (ADR-180 D5).
   *
   * The only entry here that is a *reply* rather than a request, and it is on
   * the table for the same reason everything else is: it used to be an
   * `ipcRenderer.send("app-command-result")` on a channel of its own, which
   * made it a second way for a renderer to talk to main. A `requestId` is a
   * UUID main generated and told exactly one connection, so an answer to one
   * is an answer from the renderer that was asked.
   */
  "appCommands.result": (_deps: IpcDeps, result: AppCommandResult) =>
    appCommandResult(result),
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
/**
 * Methods whose last argument is the caller's identity, supplied by the
 * transport rather than by the frame (ADR-179 D3).
 *
 * The number is how many parameters the handler declares before the origin —
 * `pty.create`'s optional `agentKind` included, so a client that omits it
 * still gets the origin in the *next* slot rather than in `agentKind`'s. The
 * bridge pads the wire arguments out to this length and appends the
 * connection's own `LayoutOrigin`, so no caller can claim to be another
 * renderer and pick up its selection hints, or attach as another
 * connection's pane viewer and take the winsize with it (D6).
 */
export const ORIGIN_ARGS: ReadonlyMap<string, number> = new Map([
  ["layout.apply", 2],
  ["layout.reportViewport", 3],
  ["pty.create", 5],
  ["pty.reset", 4],
  ["pty.resize", 3],
  ["pty.close", 1],
  ["pty.detach", 1],
]);

export const MUTATING: ReadonlySet<string> = new Set([
  "pty.create",
  "pty.reset",
  "pty.close",
  "layout.apply",
  "layout.setPendingCommand",
  "layout.remove",
  "projects.select",
  "projects.selectWorkspace",
  "preferences.set",
  "agents.setPaneContext",
]);

/**
 * Methods a paired device may not call, however `full` its tier (ADR-180 D4).
 *
 * The other half of `BridgeRefusal`: that one is a handler refusing everyone,
 * this is the table refusing one class of caller. `local` — an Electron
 * renderer window on this machine — is authenticated by being one, and may
 * call anything here; a `device` calling one of these gets `unavailable:web`,
 * which is exactly what it gets today from a method simply being absent. The
 * difference is that it becomes a decision written down rather than a hole,
 * and `allowlist.test.ts` can assert the list instead of asserting silence.
 *
 * The prewarm pair is the first entry, and arrived with `pty` (ADR-180
 * ticket 5). The rest of the list this is for — `keybindings.set`/`reset`/
 * `resetAll`, `remoteControl.setEnabled`/`pair`/`revoke`/`tunnel.*` and
 * `viewport.load`/`save` — joins it as each of those namespaces crosses;
 * naming them before they exist would be a list of methods that refuse
 * nothing.
 */
export const LOCAL_ONLY: ReadonlySet<string> = new Set<string>([
  "pty.consumePrewarmed",
  "pty.updatePrewarmCwd",
]);
