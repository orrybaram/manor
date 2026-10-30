import type { BroadcastBus } from "../../renderer-broadcast";
import type { SharedDeps } from "../../ipc/types";
import type { StatsHistory, StatsSummary } from "../../stats-store";
import { method, type HandlerCtx } from "../method";

/**
 * The usage-stats surface, whole. `statsStore` is
 * main's single source of truth; the renderer only caches the summary it
 * broadcasts here.
 *
 * A burst of recording (e.g. a flurry of tool calls) must not turn into a
 * burst of broadcasts, so `wireStatsBroadcast`'s subscription is debounced —
 * see `BROADCAST_DEBOUNCE_MS`.
 */
/** What the stats surface reads: the store, on the desktop and on a host server alike. */
type StatsDeps = Pick<SharedDeps, "statsStore">;

export const BROADCAST_DEBOUNCE_MS = 1000;

export function statsGetSummary(ctx: HandlerCtx<StatsDeps>): StatsSummary {
  return ctx.deps.statsStore.getSummary();
}

/**
 * This server's own counts and awards, without any host's: what a desktop
 * reads from each host server to merge into its totals.
 */
export function statsGetHistory(ctx: HandlerCtx<StatsDeps>): StatsHistory {
  return ctx.deps.statsStore.getHistory();
}

export function statsReset(ctx: HandlerCtx<StatsDeps>): void {
  ctx.deps.statsStore.reset();
}

/**
 * Wire the debounced `stats.changed` broadcast.
 *
 * The subscription that turns a burst of recording into one broadcast runs
 * once, at boot, on every server (`createManorServer`): a host server's
 * `stats.changed` is how the desktop knows to read its history again.
 */
export function wireStatsBroadcast(
  deps: StatsDeps,
  publish: BroadcastBus["publish"],
): void {
  const { statsStore } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  statsStore.onChange(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      publish("stats", "changed", statsStore.getSummary());
    }, BROADCAST_DEBOUNCE_MS);
  });
}

export const stats = {
  getSummary: method(statsGetSummary),
  getHistory: method(statsGetHistory),
  reset: method(statsReset, { mutating: true }),
};
