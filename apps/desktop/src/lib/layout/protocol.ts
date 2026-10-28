/**
 * The layout wire, as both ends of it read it.
 *
 * The Manor server (`electron/layout/layout-store.ts`) writes these and every
 * renderer reads them, over IPC or a socket; the layout file
 * (`electron/terminal-host/layout-persistence.ts`) keeps the session half of
 * them on disk. One definition, imported by all of them, so the two sides
 * cannot drift apart on a field.
 *
 * Types only: the terminal-host bundle and the web bundle both import this,
 * and neither may pull the other's runtime in behind it.
 */

import type { LayoutHint, WorkspaceViewport } from "./viewport";
import type { LayoutClaim } from "./visible-tabs";
import type { WorkspaceLayout } from "./workspace-layout";

/**
 * A pane's last Agent status, as the Status reconciler published it — the renderer's `PaneAgentStatus`. Older files hold an earlier shape;
 * a renderer only ever reads `status` and `kind` back out of it.
 */
export interface PersistedAgentState {
  status: string;
  reason?: string;
  kind: string | null;
}

/**
 * What the server knows about one pane's session.
 *
 * Server-derived from the PTY stream and the Status reconciler, never
 * reported by a renderer. It rides
 * along with `layout.getAll()` so a restoring renderer can reattach, and with
 * a reopen's or a move's `restored` so a pane that came back mounts with its
 * cwd and title.
 */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
  lastTitle: string | null;
  lastAgentStatus?: PersistedAgentState | null;
}

/**
 * What one renderer is looking at. The layout file keeps one per
 * workspace — the default viewport, handed to a renderer that has none.
 */
export type PersistedDefaultViewport = WorkspaceViewport;

/**
 * One renderer's viewport file: `~/.manor/viewport.json` for the desktop's
 * primary window, `localStorage` for a browser tab.
 *
 * Per renderer, deliberately — two windows of one host reopen on the tabs
 * each of them had, not on the tabs the last command happened to touch.
 */
export interface PersistedViewportFile {
  version: 1;
  /** The surface this renderer was last on, Home included. */
  activeWorkspacePath: string | null;
  workspaces: Record<string, PersistedDefaultViewport>;
}

/** One workspace, as the Manor server holds it and a reader is handed it. */
export interface LayoutEntry {
  version: number;
  layout: WorkspaceLayout;
  defaultViewport: PersistedDefaultViewport;
  /** Server-derived; a restoring renderer reattaches sessions from it. */
  paneSessions: Record<string, PersistedPaneSession>;
  /** Tabs held by a detached window right now. Never persisted. */
  claims: LayoutClaim[];
}

/**
 * Who sent a command, or reported a viewport.
 *
 * `window` is a renderer on this machine, `bridge` a paired device, `route`
 * the CLI, MCP or the server itself; the id is the connection id a renderer
 * is told as its `rendererId`. A command's origin is recorded rather than
 * acted on: the sender gets the same broadcast as everybody else. A
 * viewport report's origin is load bearing, because only a `window` can hold
 * a claim, and `id` is the window main is asked about.
 */
export interface LayoutOrigin {
  kind: "window" | "bridge" | "route";
  id: string;
}

/**
 * What `layout.changed` carries: the whole workspace layout, to every
 * renderer at once.
 */
export interface LayoutBroadcast {
  workspacePath: string;
  version: number;
  layout: WorkspaceLayout;
  /**
   * Who is holding which tab of this workspace in a window of its own.
   *
   * Travels on *every* broadcast, and a change to it is a broadcast in its own
   * right — at the same version, because a claim is not structure. A renderer
   * therefore compares `(version, claims)` rather than the version alone.
   */
  claims: LayoutClaim[];
  /**
   * Who sent the command this broadcast is the result of. A renderer
   * applies `hint` only when `origin.id` is its own `rendererId`; everybody
   * else keeps looking where they were looking.
   */
  origin: LayoutOrigin;
  /** What the command implies about the *sender's* selection. */
  hint?: LayoutHint;
  /**
   * What the server knows about the panes a `reopen-closed-pane` just put
   * back, or a move to another workspace just brought in, and only those.
   * Their sessions are still running, so the pane reattaches a warm shell and
   * this is the cwd, title and status to mount it with. Every other change to `paneSessions` stays unbroadcast — a
   * renderer hears the PTY events it is made of.
   */
  restored?: Record<string, PersistedPaneSession>;
  /**
   * The workspace is gone — its worktree was removed and the server has
   * already ended its panes. `layout` and `version` are the last
   * ones it had; a renderer drops its copy rather than adopting them.
   */
  removed?: true;
}

/** The renderer's name for the same payload. */
export type LayoutChangedPayload = LayoutBroadcast;

/**
 * What `layout.apply` answers: the version the workspace is at afterwards,
 * never a layout — that arrives on `layout.changed`, at every renderer.
 *
 * `hint` is the command's selection hint, answered even when the command
 * changed nothing and so broadcast nothing (an extract of a pane that is
 * already a tab still says which tab). `addedPaneIds` are the panes the
 * command put into the tree — what a reopen brought back.
 */
export type LayoutApplyResult =
  | { version: number; hint?: LayoutHint; addedPaneIds: string[] }
  | { error: string };

/**
 * What a tab or a pane moved to another workspace answers
 * (`layout.moveToWorkspace`): where it landed, enough for the sender to
 * follow it there. `workspacePath` is the target's workspace key, `tabId` the
 * tab it is in now, `paneId` the pane to focus (the moved pane, or a moved
 * tab's first), and `hint` the selection the target's broadcast carried for
 * the sender. `version` is the target's.
 */
export type WorkspaceMoveResult =
  | {
      workspacePath: string;
      tabId: string;
      paneId: string;
      version: number;
      hint: LayoutHint;
    }
  | { error: string };

/**
 * A pane's title, off the command channel.
 *
 * `title: null` clears it. A renderer feeds this straight into
 * `setPaneTitleFromStream` — the same sink an OSC title write already uses —
 * so a route, an MCP call or another renderer's edit reads the same way a
 * local terminal's own title does.
 */
export interface LayoutPaneTitlePayload {
  paneId: string;
  title: string | null;
}
