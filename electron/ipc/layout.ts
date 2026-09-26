import { ipcMain } from "electron";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { PersistedWorkspace } from "../terminal-host/layout-persistence";
import type { IpcDeps } from "./types";

/**
 * The read side, lifted out of its `ipcMain.handle` wrapper so the ADR-178
 * WebSocket bridge calls the same code the desktop renderer does.
 *
 * `layout:save` is deliberately *not* lifted. Layout is still owned by the
 * renderer until ADR-178's slice 2 (D6), and two renderers writing
 * `~/.manor/layout.json` is last-write-wins on the user's whole workspace
 * arrangement. The bridge refuses it by name instead — see `ws-handlers.ts`.
 */
export function layoutLoad(deps: IpcDeps): unknown {
  return deps.layoutPersistence.load();
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

  ipcMain.handle("layout:getRestoredSessions", () =>
    layoutGetRestoredSessions(deps),
  );
}
