import { ipcMain } from "electron";
import { BROADCAST_DEBOUNCE_MS } from "./stats";
import type { IpcDeps } from "./types";

/**
 * ADR-199's Agent activity IPC surface. `agentActivityStore` is main's single
 * source of truth; the renderer only caches the snapshot broadcast here.
 *
 * Busy agents change status many times a minute, so the `onChange`
 * subscription is debounced the same way `stats:changed` is.
 */
export function register(deps: IpcDeps): void {
  const { agentActivityStore } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleBroadcast = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const snapshot = agentActivityStore.getSnapshot();
      for (const win of deps.getRendererWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try {
          win.webContents.send("agentActivity:changed", snapshot);
        } catch {
          // a torn-down webContents mid-send is not worth crashing over
        }
      }
    }, BROADCAST_DEBOUNCE_MS);
  };

  agentActivityStore.onChange(scheduleBroadcast);

  ipcMain.handle("agentActivity:get", () => agentActivityStore.getSnapshot());
}
