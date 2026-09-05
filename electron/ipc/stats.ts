import { ipcMain } from "electron";
import type { IpcDeps } from "./types";

/**
 * ADR-168's usage-stats IPC surface. `statsStore` is main's single source of
 * truth; the renderer only caches the summary it broadcasts here.
 *
 * A burst of recording (e.g. a flurry of tool calls) must not turn into a
 * burst of broadcasts, so the `onChange` subscription below is debounced —
 * see `BROADCAST_DEBOUNCE_MS`.
 */
export const BROADCAST_DEBOUNCE_MS = 1000;

export function register(deps: IpcDeps): void {
  const { statsStore } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleBroadcast = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const summary = statsStore.getSummary();
      for (const win of deps.getRendererWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try {
          win.webContents.send("stats:changed", summary);
        } catch {
          // a torn-down webContents mid-send is not worth crashing over
        }
      }
    }, BROADCAST_DEBOUNCE_MS);
  };

  statsStore.onChange(scheduleBroadcast);

  ipcMain.handle("stats:getSummary", () => statsStore.getSummary());

  ipcMain.handle("stats:reset", () => {
    statsStore.reset();
  });
}
