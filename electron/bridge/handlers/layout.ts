import type { WorkspaceViewport } from "../../../src/lib/layout/viewport";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../../../src/lib/layout/protocol";
import type { LayoutCommand } from "../../../src/lib/layout/commands";
import type {
  PendingCommandKind,
  PendingCommandOptions,
} from "../../layout/pending-commands";
import { assertString } from "../../ipc-validate";
import {
  byPane,
  byWorkspaceKey,
  LOCAL_ROUTE,
  method,
  type Caller,
  type HandlerCtx,
} from "../method";
import type { SharedDeps } from "../../ipc/types";

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
 * window that sent it, and `kind` decides whether a viewport report may stand
 * in for the primary's or take up a detached window's claim (D4). The frame
 * never supplies it.
 */
function originOf(caller: Caller): LayoutOrigin {
  return {
    kind: caller.callerClass === "local" ? "window" : "bridge",
    id: caller.id,
  };
}

/**
 * Who a command came from, as the layout store records it: the caller — or,
 * on a host server, the desktop's own caller, which the owner forwards it
 * for (ADR-227 D4), so the broadcast's hint lands on the renderer that sent
 * it. Only main's owner channel may say; anyone else's third argument is
 * ignored. A desktop window's viewer stream (ADR-228 D4) is an owner too,
 * but it is the renderer itself: its own connection is the origin.
 */
function commandOrigin(caller: Caller, forwardedFor: unknown): LayoutOrigin {
  if (
    caller.callerClass !== "owner" ||
    caller.viewer !== undefined ||
    !isOrigin(forwardedFor)
  ) {
    return originOf(caller);
  }
  return { kind: forwardedFor.kind, id: forwardedFor.id };
}

function isOrigin(value: unknown): value is LayoutOrigin {
  if (typeof value !== "object" || value === null) return false;
  const { kind, id } = value as Partial<LayoutOrigin>;
  return (kind === "window" || kind === "bridge" || kind === "route") && typeof id === "string";
}

/**
 * Every workspace's layout: this server's, and on the desktop every adopted
 * remote host's, from its server (ADR-227 D4) — the cache's while it is away.
 */
export async function layoutGetAll(
  ctx: HandlerCtx<SharedDeps>,
): Promise<Record<string, LayoutEntry>> {
  // Waits for the file, and so for the one-time workspace-key migration
  // (ADR-191) under it: a renderer only ever sees host-qualified keys.
  await ctx.deps.layoutStore.whenLoaded();
  const remote = ctx.deps.hostRouting?.layout() ?? {};
  return { ...remote, ...ctx.deps.layoutStore.getAll() };
}

/** The fallback surface for a renderer with no viewport file of its own. */
export async function layoutGetLastActive(
  ctx: HandlerCtx<SharedDeps>,
): Promise<string | null> {
  await ctx.deps.layoutStore.whenLoaded();
  const local = ctx.deps.layoutStore.getLastActiveWorkspacePath();
  return ctx.deps.hostRouting?.lastActiveWorkspace(local) ?? local;
}

/**
 * Run one layout command. The answer is the version, the command's selection
 * hint and the panes it added — not the new layout, which arrives on
 * `layout.changed`, at every renderer at once.
 */
export function layoutApply(
  ctx: HandlerCtx<SharedDeps>,
  workspacePath: string,
  command: LayoutCommand,
  forwardedFor?: LayoutOrigin | null,
): Promise<LayoutApplyResult> {
  assertString(workspacePath, "workspacePath");
  ctx.deps.hostRouting?.noteActive(workspacePath);
  return ctx.deps.layoutStore.apply(
    workspacePath,
    command,
    commandOrigin(ctx.caller, forwardedFor),
  );
}

/**
 * Queue a command for a pane whose shell does not exist yet.
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
  ctx: HandlerCtx<SharedDeps>,
  paneId: string,
  text: string,
  kind: PendingCommandKind = "shell",
  opts?: PendingCommandOptions | null,
): void {
  assertString(paneId, "paneId");
  assertString(text, "text");
  if (kind !== "shell" && kind !== "agent-startup") {
    throw new Error(`Unknown pending command kind: ${String(kind)}`);
  }
  if (opts?.submit !== undefined && typeof opts.submit !== "boolean") {
    throw new Error("submit must be a boolean");
  }
  if (opts?.prompt !== undefined && typeof opts.prompt !== "string") {
    throw new Error("prompt must be a string");
  }
  ctx.deps.layoutStore.pendingCommands.set(paneId, text, kind, opts ?? undefined);
}

/**
 * A pane's title, off the command channel (ADR-182 D1).
 *
 * The desktop's OSC-title writes still go through `setPaneTitleFromStream`
 * locally and are not sent here (the server already learns them from the
 * daemon's own `pty.agentStatus`/title events) — this is for the other
 * sources: a browser's own title edit, an MCP/CLI call. Silent on an unknown
 * paneId: a stale id from a slow renderer is normal, not an error.
 */
export function layoutSetPaneTitle(
  ctx: HandlerCtx<SharedDeps>,
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
 * window or a browser?" decides whether the report stands in for the
 * primary's viewport, and a client cannot be trusted to answer it about
 * itself. No claim rides in the viewport: `LayoutStore.reportViewport` asks
 * main which tab a window holds, so a phone cannot make a tab vanish from the
 * desk.
 */
export function layoutReportViewport(
  ctx: HandlerCtx<SharedDeps>,
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

/**
 * On the desktop, a remote workspace's layout is its host server's
 * (ADR-227 D4): a command names it by key, a title or a queued command by
 * pane, and goes there. The reads merge every host's.
 */
export const layout = {
  getAll: method(layoutGetAll, { route: LOCAL_ROUTE }),
  getLastActive: method(layoutGetLastActive, { route: LOCAL_ROUTE }),
  // ADR-179 D1: a browser arranges panes by sending the same commands the
  // desktop sends. `workspacePath` first, so the audit line's target is the
  // workspace the command moved.
  apply: method(layoutApply, { mutating: true, route: byWorkspaceKey(0) }),
  setPaneTitle: method(layoutSetPaneTitle, { mutating: true, route: byPane(0) }),
  // A pane no layout holds yet stays here, and goes with the command that
  // adds it (`HostRouting`).
  setPendingCommand: method(layoutSetPendingCommand, { mutating: true, route: byPane(0) }),
  // A window's report, and its claim, are the desktop's whatever workspace
  // it names (ADR-228 D7): a host server has no windows to hold a claim.
  reportViewport: method(layoutReportViewport, { route: LOCAL_ROUTE }),
};
