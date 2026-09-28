import { ipcMain } from "electron";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { PersistedWorkspace } from "../terminal-host/layout-persistence";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { backend, layoutPersistence } = deps;

  // Both wait for the one-time workspace-key migration (ADR-191), so the
  // renderer only ever sees, and writes, host-qualified keys.
  ipcMain.handle("layout:save", async (_event, workspace: PersistedWorkspace) => {
    await layoutPersistence.whenReady();
    try {
      layoutPersistence.saveWorkspace(workspace);
    } catch (err) {
      console.error("Failed to save layout:", err);
    }
  });

  ipcMain.handle("layout:load", async () => {
    await layoutPersistence.whenReady();
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
