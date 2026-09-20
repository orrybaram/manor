import { ipcMain } from "electron";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type {
  PersistedDefaultViewport,
  PersistedWorkspace,
} from "../terminal-host/layout-persistence";
import type {
  LayoutApplyResult,
  LayoutEntry,
  LayoutOrigin,
} from "../layout/layout-store";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

/**
 * The read side, lifted out of its `ipcMain.handle` wrapper so the ADR-178
 * WebSocket bridge calls the same code the desktop renderer does.
 *
 * `layout:save` is deliberately *not* lifted, and stays refused on the bridge:
 * it is the renderer-owned path ADR-179 replaces. `layout:getAll` /
 * `layout:apply` are that replacement — the Manor server owns the layout and
 * every renderer, desktop or browser, drives it by command (D1).
 */
export function layoutLoad(deps: IpcDeps): unknown {
  return deps.layoutPersistence.load();
}

/** Every workspace's structure, version and default viewport (ADR-179 D1). */
export function layoutGetAll(deps: IpcDeps): Record<string, LayoutEntry> {
  return deps.layoutStore.getAll();
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
  const { layoutPersistence } = deps;

  ipcMain.handle("layout:save", (_event, workspace: PersistedWorkspace) => {
    try {
      layoutPersistence.saveWorkspace(workspace);
    } catch (err) {
      console.error("Failed to save layout:", err);
    }
  });

  ipcMain.handle("layout:load", () => layoutLoad(deps));

  ipcMain.handle("layout:getAll", () => layoutGetAll(deps));

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
