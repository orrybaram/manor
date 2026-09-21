import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { IpcDeps } from "../../ipc/types";

/**
 * ADR-168's usage-stats surface, whole (ADR-180 ticket 7). `statsStore` is
 * main's single source of truth; the renderer only caches the summary it
 * broadcasts here.
 *
 * A burst of recording (e.g. a flurry of tool calls) must not turn into a
 * burst of broadcasts, so `wireStatsBroadcast`'s subscription is debounced —
 * see `BROADCAST_DEBOUNCE_MS`.
 */
export const BROADCAST_DEBOUNCE_MS = 1000;

export function statsGetSummary(deps: IpcDeps): unknown {
  return deps.statsStore.getSummary();
}

export function statsReset(deps: IpcDeps): void {
  deps.statsStore.reset();
}

/**
 * Wire the debounced `stats.changed` broadcast.
 *
 * Not `register()` — there is no `ipcMain.handle` left in this file (ADR-180
 * ticket 7 lifted both calls onto the handler table) — but the subscription
 * that turns a burst of recording into one broadcast still has to run once,
 * at boot, so `app-lifecycle.ts` calls this in `register()`'s place.
 */
export function wireStatsBroadcast(deps: Pick<IpcDeps, "statsStore">): void {
  const { statsStore } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  statsStore.onChange(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      publishRendererBroadcast("stats", "changed", statsStore.getSummary());
    }, BROADCAST_DEBOUNCE_MS);
  });
}
