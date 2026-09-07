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

/**
 * One-line explanation of what a counter measures, shown as a tooltip on the
 * stats table label. Exhaustive so a new counter fails typecheck.
 */
export function counterDescription(counter: StatCounter): string {
  switch (counter) {
    case "prompts":
      return "Messages you sent to an agent.";
    case "toolCalls":
      return "Tools an agent ran: file reads, edits, shell commands and so on.";
    case "agentSessions":
      return "Agent sessions started in a terminal.";
    case "subagents":
      return "Subagents spawned by an agent to work in parallel.";
    case "agentsResponded":
      return "Times an agent finished a turn and handed control back to you.";
    case "agentsKilled":
      return "Live agents you terminated by closing their pane or killing the session.";
    case "blocks":
      return "Times an agent stopped to wait on you: a permission prompt or a question.";
    case "unblocks":
      return "Times you replied to a waiting agent.";
    case "unblockMsTotal":
      return "Total time agents spent waiting on you.";
    case "fastUnblocks":
      return "Unblocks where you replied in under a minute.";
    case "worktreesCreated":
      return "Git worktrees created for a workspace.";
    case "worktreesRemoved":
      return "Git worktrees removed.";
    case "worktreesMerged":
      return "Worktrees merged back into the base branch with quick merge.";
    case "prApproved":
      return "Pull requests of yours that received an approval.";
    case "prChangesRequested":
      return "Pull requests of yours where a reviewer requested changes.";
    case "prChecksFailed":
      return "Pull requests of yours where a CI check failed.";
    default: {
      const _exhaustive: never = counter;
      return _exhaustive;
    }
  }
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
