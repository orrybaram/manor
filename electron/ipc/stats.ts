import { ipcMain } from "electron";
import { publishRendererBroadcast } from "../renderer-broadcast";
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

/** Lifted for the ADR-178 bridge; see `electron/bridge/handlers.ts`. */
export function statsGetSummary(deps: IpcDeps): unknown {
  return deps.statsStore.getSummary();
}

export function register(deps: IpcDeps): void {
  const { statsStore } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleBroadcast = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const summary = statsStore.getSummary();
      publishRendererBroadcast("stats", "changed", summary);
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

  ipcMain.handle("stats:getSummary", () => statsGetSummary(deps));

  ipcMain.handle("stats:reset", () => {
    statsStore.reset();
  });
}
