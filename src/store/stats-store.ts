import { create } from "zustand";
import type { DayBucket, StatCounter, StatsSummary } from "../electron.d";

/**
 * Renderer cache of main's usage-stats summary (ADR-168 §5).
 *
 * Main owns the counters. Every mutation (record, reset) arrives back through
 * the `stats:changed` broadcast — the renderer never mutates its copy
 * speculatively, the same ownership split ADR-162 uses for notifications.
 */
interface StatsState {
  /** `null` until the first summary arrives (broadcast or initial fetch). */
  summary: StatsSummary | null;
  loaded: boolean;
  reset: () => Promise<void>;
}

export const useStatsStore = create<StatsState>((set) => {
  const api = window.electronAPI?.stats;

  api?.onChanged((summary) => {
    set({ summary, loaded: true });
  });

  const init = async (): Promise<void> => {
    if (!api) return;
    try {
      const summary = await api.getSummary();
      set({ summary, loaded: true });
    } catch {
      // leave summary null; the next broadcast (or a manual retry) recovers
    }
  };
  void init();

  return {
    summary: null,
    loaded: false,

    reset: async () => {
      await window.electronAPI?.stats.reset();
    },
  };
});

/**
 * Humanises the average unblock latency for a bucket (`unblockMsTotal /
 * unblocks`). `null` when there is nothing to divide by — a bucket with zero
 * unblocks recorded no latency at all, not a latency of zero.
 */
export function formatUnblockLatency(bucket: DayBucket): string | null {
  const unblocks = bucket.unblocks ?? 0;
  if (unblocks <= 0) return null;
  const totalMs = bucket.unblockMsTotal ?? 0;
  const avgMs = totalMs / unblocks;
  const totalSeconds = Math.round(avgMs / 1000);

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Human label for a counter row. Exhaustive so a new counter fails typecheck. */
export function humanCounterLabel(counter: StatCounter): string {
  switch (counter) {
    case "prompts":
      return "Prompts";
    case "toolCalls":
      return "Tool calls";
    case "agentSessions":
      return "Agent sessions";
    case "subagents":
      return "Subagents";
    case "agentsResponded":
      return "Agents responded";
    case "agentsKilled":
      return "Agents killed";
    case "blocks":
      return "Times blocked";
    case "unblocks":
      return "Unblocks";
    case "unblockMsTotal":
      return "Unblock time (total)";
    case "fastUnblocks":
      return "Fast unblocks";
    case "worktreesCreated":
      return "Worktrees created";
    case "worktreesRemoved":
      return "Worktrees removed";
    case "worktreesMerged":
      return "Worktrees merged";
    case "prApproved":
      return "PRs approved";
    case "prChangesRequested":
      return "PR changes requested";
    case "prChecksFailed":
      return "PR checks failed";
    default: {
      const _exhaustive: never = counter;
      return _exhaustive;
    }
  }
}
