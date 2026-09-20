import { ipcMain } from "electron";
import type { PersistedDefaultViewport } from "../terminal-host/layout-persistence";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../layout/layout-store";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import type { PendingCommandKind } from "../layout/pending-commands";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

/**
 * Layout, as every renderer sees it (ADR-179 D1).
 *
 * Lifted out of the `ipcMain.handle` wrappers below so the ADR-178 WebSocket
 * bridge calls the same code the desktop renderer does. There is no `save`
 * and no `load`: the Manor server owns `~/.manor/layout.json`, a renderer
 * reads the whole thing with `getAll` and changes it with `apply`.
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

export function register(deps: IpcDeps): void {
  ipcMain.handle("layout:getAll", () => layoutGetAll(deps));

  ipcMain.handle("layout:getLastActive", () => layoutGetLastActive(deps));

  ipcMain.handle(
    "layout:apply",
    (event, workspacePath: string, command: LayoutCommand) =>
      layoutApply(deps, workspacePath, command, {
        kind: "window",
        id: String(event.sender.id),
      }),
  );

  ipcMain.handle(
    "layout:setPendingCommand",
    (_event, paneId: string, text: string, kind?: PendingCommandKind) =>
      layoutSetPendingCommand(deps, paneId, text, kind),
  );

  ipcMain.handle("layout:remove", (_event, workspacePath: string) =>
    layoutRemove(deps, workspacePath),
  );

  ipcMain.handle(
    "layout:reportViewport",
    (
      event,
      workspacePath: string,
      rendererId: string,
      viewport: PersistedDefaultViewport,
    ) =>
      layoutReportViewport(deps, workspacePath, rendererId, viewport, {
        kind: "window",
        id: String(event.sender.id),
      }),
  );
}
