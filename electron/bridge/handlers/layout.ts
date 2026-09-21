import type { PersistedDefaultViewport } from "../../terminal-host/layout-persistence";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../../layout/layout-store";
import type { LayoutCommand } from "../../../src/lib/layout/commands";
import type { PendingCommandKind } from "../../layout/pending-commands";
import { assertString } from "../../ipc-validate";
import type { IpcDeps } from "../../ipc/types";

/**
 * Layout, as every renderer sees it (ADR-179 D1, ADR-180 D8).
 *
 * All seven of these were already on the bridge handler table when ADR-179
 * put them there; what ADR-180 ticket 6 removed is the second caller — the
 * `ipcMain.handle("layout:*")` wrappers that used to sit at the bottom of
 * this file. A desktop window reaches the same entries a browser does, so
 * the `origin` each of them carries comes from the transport either way
 * (`ORIGIN_ARGS`, D3): a window's is its connection id, which is its
 * `webContents.id` as a string — the id the wrappers used to read off
 * `event.sender`, so a command's selection hint still lands on the window
 * that sent it.
 *
 * There is no `save` and no `load`: the Manor server owns
 * `~/.manor/layout.json`, a renderer reads the whole thing with `getAll` and
 * changes it with `apply`.
 */
export function layoutGetAll(deps: IpcDeps): Record<string, LayoutEntry> {
  return deps.layoutStore.getAll();
}

/** The fallback surface for a renderer with no viewport file of its own. */
export function layoutGetLastActive(deps: IpcDeps): string | null {
  return deps.layoutStore.getLastActiveWorkspacePath();
}

/**
 * Run one layout command. The answer is the new version, not the new layout:
 * the layout arrives on `layout.changed`, at every renderer at once.
 */
export function layoutApply(
  deps: IpcDeps,
  workspacePath: string,
  command: LayoutCommand,
  origin: LayoutOrigin = { kind: "route", id: "unknown" },
): Promise<LayoutApplyResult> {
  assertString(workspacePath, "workspacePath");
  return deps.layoutStore.apply(workspacePath, command, origin);
}

/**
 * Queue a command for a pane whose shell does not exist yet (ticket 11).
 *
 * The desktop's "new tab running `pnpm dev`", "split with agent" and agent
 * launches all land here, so they take the same road as `POST /tabs
 * { command }`: the line waits on the server and `pty.create` types it into
 * whichever renderer mounts the pane first. It used to wait in the sending
 * renderer's own store, which is why a route could not queue one at all.
 *
 * Ordering matters and is free: a producer sends this immediately before the
 * `layout.apply` that creates the pane, both over the same ordered channel,
 * and this handler is synchronous — so the entry is always in place before
 * the broadcast that makes a renderer mount the pane goes out.
 */
export function layoutSetPendingCommand(
  deps: IpcDeps,
  paneId: string,
  text: string,
  kind: PendingCommandKind = "shell",
): void {
  assertString(paneId, "paneId");
  assertString(text, "text");
  if (kind !== "shell" && kind !== "agent-startup") {
    throw new Error(`Unknown pending command kind: ${String(kind)}`);
  }
  deps.layoutStore.pendingCommands.set(paneId, text, kind);
}

/** Forget a workspace's layout — its worktree is gone. */
export function layoutRemove(deps: IpcDeps, workspacePath: string): void {
  assertString(workspacePath, "workspacePath");
  deps.layoutStore.remove(workspacePath);
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
  deps: IpcDeps,
  paneId: string,
  title: string | null,
): void {
  assertString(paneId, "paneId");
  deps.layoutStore.setPaneTitle(paneId, title);
}

/**
 * What one renderer is looking at (ADR-179 D3).
 *
 * `rendererId` is what the *caller* calls itself and `origin` is what the
 * transport saw; the transport wins, because "was this a window or a
 * browser?" decides whether the report stands in for the primary's viewport
 * and a client cannot be trusted to answer it about itself.
 */
export function layoutReportViewport(
  deps: IpcDeps,
  workspacePath: string,
  rendererId: string,
  viewport: PersistedDefaultViewport,
  origin: LayoutOrigin = { kind: "route", id: rendererId },
): void {
  assertString(workspacePath, "workspacePath");
  assertString(rendererId, "rendererId");
  deps.layoutStore.reportViewport(workspacePath, origin, viewport);
}
