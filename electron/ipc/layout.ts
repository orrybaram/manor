import { ipcMain } from "electron";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { PersistedDefaultViewport } from "../terminal-host/layout-persistence";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../layout/layout-store";
import type { LayoutCommand } from "../../src/lib/layout/commands";
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

/** The surface to reopen on relaunch — viewport, until ticket 4 moves it. */
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

/** Forget a workspace's layout — its worktree is gone. */
export function layoutRemove(deps: IpcDeps, workspacePath: string): void {
  assertString(workspacePath, "workspacePath");
  deps.layoutStore.remove(workspacePath);
}

/** What one renderer is looking at (ADR-179 D3; ticket 4 gives it teeth). */
export function layoutReportViewport(
  deps: IpcDeps,
  workspacePath: string,
  rendererId: string,
  viewport: PersistedDefaultViewport,
): void {
  assertString(workspacePath, "workspacePath");
  assertString(rendererId, "rendererId");
  deps.layoutStore.reportViewport(workspacePath, rendererId, viewport);
}

export async function layoutGetRestoredSessions(deps: IpcDeps): Promise<{
  daemonSessions: unknown[];
  persistedSessionIds: string[];
}> {
  try {
    // Get live daemon sessions and persisted scrollback sessions
    const daemonSessions = await deps.backend.pty.listSessions();
    const persistedSessionIds = ScrollbackWriter.listPersistedSessions();
    return {
      daemonSessions,
      persistedSessionIds,
    };
  } catch {
    return { daemonSessions: [], persistedSessionIds: [] };
  }
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

  ipcMain.handle("layout:remove", (_event, workspacePath: string) =>
    layoutRemove(deps, workspacePath),
  );

  ipcMain.handle(
    "layout:reportViewport",
    (
      _event,
      workspacePath: string,
      rendererId: string,
      viewport: PersistedDefaultViewport,
    ) => layoutReportViewport(deps, workspacePath, rendererId, viewport),
  );

  ipcMain.handle("layout:getRestoredSessions", () =>
    layoutGetRestoredSessions(deps),
  );
}
