import { ipcMain } from "electron";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { PersistedWorkspace } from "../terminal-host/layout-persistence";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { backend, layoutPersistence } = deps;

  ipcMain.handle("layout:save", (_event, workspace: PersistedWorkspace) => {
    try {
      layoutPersistence.saveWorkspace(workspace);
    } catch (err) {
      console.error("Failed to save layout:", err);
    }
  });

  ipcMain.handle("layout:load", () => {
    return layoutPersistence.load();
  });

  ipcMain.handle("layout:getRestoredSessions", async () => {
    // Get live daemon sessions and persisted scrollback sessions
    // so the renderer can reconcile on startup
    try {
      const daemonSessions = await backend.pty.listSessions();
      const persistedSessionIds = ScrollbackWriter.listPersistedSessions();
      return {
        daemonSessions,
        persistedSessionIds,
      };
    } catch {
      return { daemonSessions: [], persistedSessionIds: [] };
    }
  });
}
