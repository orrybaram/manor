import { create } from "zustand";
import type { StatsSummary } from "../../electron.d";
import { BADGE_SECTIONS, trackState, type BadgeSection } from "../../lib/badges";
import { useStatsStore } from "../../store/stats-store";
import { useMountEffect } from "../../hooks/useMountEffect";

/** One thing to celebrate: a badge, or a track turning sealed or gilded. */
export type UnlockItem =
  | { kind: "badge"; id: string }
  | { kind: "seal"; section: BadgeSection }
  | { kind: "gild"; section: BadgeSection };

/** Stable key for an item, used to remount the toast between items. */
export function unlockKey(item: UnlockItem): string {
  return item.kind === "badge" ? `badge:${item.id}` : `${item.kind}:${item.section}`;
}

/**
 * What is new in `next` compared to `prev`: badge ids first (in the order
 * `next.badges` lists them), then tracks that just became sealed, then gilded.
 */
export function diffUnlocks(
  prev: StatsSummary,
  next: StatsSummary,
): UnlockItem[] {
  const items: UnlockItem[] = [];
  for (const id of Object.keys(next.badges)) {
    if (prev.badges[id] === undefined) items.push({ kind: "badge", id });
  }
  for (const section of BADGE_SECTIONS) {
    const before = trackState(section, prev);
    const after = trackState(section, next);
    if (!before.sealed && after.sealed) {
      items.push({ kind: "seal", section: section.id });
    }
    if (!before.gilded && after.gilded) {
      items.push({ kind: "gild", section: section.id });
    }
  }
  return items;
}

interface UnlockQueueState {
  queue: UnlockItem[];
  enqueue: (items: UnlockItem[]) => void;
  /** Drop the item at the head of the queue. */
  dismiss: () => void;
  clear: () => void;
}

export const useUnlockQueue = create<UnlockQueueState>((set) => ({
  queue: [],
  enqueue: (items) => {
    if (items.length === 0) return;
    set((s) => ({ queue: [...s.queue, ...items] }));
  },
  dismiss: () => set((s) => ({ queue: s.queue.slice(1) })),
  clear: () => set({ queue: [] }),
}));

/**
 * Watch the stats store and queue every unlock after the first summary. The
 * first non-null summary is only a baseline, so the backlog never replays.
 * Returns an unsubscribe function.
 */
export function watchBadgeUnlocks(): () => void {
  let previous: StatsSummary | null = null;
  const handle = (summary: StatsSummary | null): void => {
    if (!summary) return;
    if (previous) {
      useUnlockQueue.getState().enqueue(diffUnlocks(previous, summary));
    }
    previous = summary;
  };
  handle(useStatsStore.getState().summary);
  return useStatsStore.subscribe((state) => handle(state.summary));
}

/** Mount-once subscription feeding {@link useUnlockQueue}. */
export function useBadgeUnlocks(): void {
  useMountEffect(() => watchBadgeUnlocks());
}
