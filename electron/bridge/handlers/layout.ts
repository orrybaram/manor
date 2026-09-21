import type { WorkspaceViewport } from "../../../src/lib/layout/viewport";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../../layout/layout-store";
import type { LayoutCommand } from "../../../src/lib/layout/commands";
import type { PendingCommandKind } from "../../layout/pending-commands";
import { assertString } from "../../ipc-validate";
import { method, type Caller, type HandlerCtx } from "../method";

/**
 * Layout, as every renderer sees it (ADR-179 D1, ADR-180 D8).
 *
 * There is no `save` and no `load`: the Manor server owns
 * `~/.manor/layout.json`, a renderer reads the whole thing with `getAll` and
 * changes it with `apply`.
 */

/**
 * The caller, as `LayoutStore` records it (ADR-179 D3).
 *
 * `window` for a renderer on this machine and `bridge` for a paired device.
 * A window's id is its `webContents.id` as a string — the same id the page is
 * told as its `rendererId` — so a command's selection hint lands on the
 * window that sent it, and `kind` decides whether a viewport report's claim is
 * honoured (D4). The frame never supplies it.
 */
function originOf(caller: Caller): LayoutOrigin {
  return {
    kind: caller.callerClass === "local" ? "window" : "bridge",
    id: caller.id,
  };
}

export function layoutGetAll(ctx: HandlerCtx): Record<string, LayoutEntry> {
  return ctx.deps.layoutStore.getAll();
}

/** The fallback surface for a renderer with no viewport file of its own. */
export function layoutGetLastActive(ctx: HandlerCtx): string | null {
  return ctx.deps.layoutStore.getLastActiveWorkspacePath();
}

/**
 * Run one layout command. The answer is the new version, not the new layout:
 * the layout arrives on `layout.changed`, at every renderer at once.
 */
export function layoutApply(
  ctx: HandlerCtx,
  workspacePath: string,
  command: LayoutCommand,
): Promise<LayoutApplyResult> {
  assertString(workspacePath, "workspacePath");
  return ctx.deps.layoutStore.apply(
    workspacePath,
    command,
    originOf(ctx.caller),
  );
}

/**
 * Queue a command for a pane whose shell does not exist yet (ticket 11).
 *
 * The desktop's "new tab running `pnpm dev`", "split with agent" and agent
 * launches all land here, so they take the same road as `POST /tabs
 * { command }`: the line waits on the server and `pty.create` types it into
 * whichever renderer mounts the pane first.
 *
 * Ordering matters and is free: a producer sends this immediately before the
 * `layout.apply` that creates the pane, both over the same ordered channel,
 * and this handler is synchronous — so the entry is always in place before
 * the broadcast that makes a renderer mount the pane goes out.
 */
export function layoutSetPendingCommand(
  ctx: HandlerCtx,
  paneId: string,
  text: string,
  kind: PendingCommandKind = "shell",
): void {
  assertString(paneId, "paneId");
  assertString(text, "text");
  if (kind !== "shell" && kind !== "agent-startup") {
    throw new Error(`Unknown pending command kind: ${String(kind)}`);
  }
  ctx.deps.layoutStore.pendingCommands.set(paneId, text, kind);
}

/** Forget a workspace's layout — its worktree is gone. */
export function layoutRemove(ctx: HandlerCtx, workspacePath: string): void {
  assertString(workspacePath, "workspacePath");
  ctx.deps.layoutStore.remove(workspacePath);
}

/**
 * A pane's title, off the command channel (ADR-182 D1).
 *
 * The desktop's OSC-title writes still go through `setPaneTitleFromStream`
 * locally and are not sent here (the server already learns them from the
 * daemon's own `pty.agentStatus`/title events) — this is for the other
 * sources: a browser's own title edit, an MCP/CLI call. Silent on an unknown
 * paneId, the same as `layout.remove` on an unknown workspace: a stale id
 * from a slow renderer is normal, not an error.
 */
export function layoutSetPaneTitle(
  ctx: HandlerCtx,
  paneId: string,
  title: string | null,
): void {
  assertString(paneId, "paneId");
  ctx.deps.layoutStore.setPaneTitle(paneId, title);
}

/**
 * What the calling renderer is looking at (ADR-179 D3).
 *
 * Who is reporting is the caller, not anything in the frame: "was this a
 * window or a browser?" decides whether a `claim` is honoured and whether the
 * report stands in for the primary's viewport, and a client cannot be trusted
 * to answer it about itself. `LayoutStore.reportViewport` drops a claim from
 * anything but a window, so a phone cannot make a tab vanish from the desk.
 */
export function layoutReportViewport(
  ctx: HandlerCtx,
  workspacePath: string,
  viewport: WorkspaceViewport,
): void {
  assertString(workspacePath, "workspacePath");
  if (typeof viewport !== "object" || viewport === null) {
    throw new Error("viewport: expected an object");
  }
  ctx.deps.layoutStore.reportViewport(
    workspacePath,
    originOf(ctx.caller),
    viewport,
  );
}

export const layout = {
  getAll: method(layoutGetAll),
  getLastActive: method(layoutGetLastActive),
  // ADR-179 D1: a browser arranges panes by sending the same commands the
  // desktop sends. `workspacePath` first, so the audit line's target is the
  // workspace the command moved.
  apply: method(layoutApply, { mutating: true }),
  setPaneTitle: method(layoutSetPaneTitle, { mutating: true }),
  setPendingCommand: method(layoutSetPendingCommand, { mutating: true }),
  remove: method(layoutRemove, { mutating: true }),
  reportViewport: method(layoutReportViewport),
};
