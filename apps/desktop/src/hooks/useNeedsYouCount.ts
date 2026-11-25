import { useMemo } from "react";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { useActiveSnoozes } from "../store/snooze-store";
import { itemKey, needsYouItems, type NeedsYouInput } from "../lib/home-dashboard";

/** How many Needs you items the dashboard shows: every item minus the snoozed ones. */
export function visibleNeedsYouCount(
  input: NeedsYouInput,
  snoozed: ReadonlySet<string>,
): number {
  let count = 0;
  for (const item of needsYouItems(input)) {
    if (!snoozed.has(itemKey(item))) count++;
  }
  return count;
}

/** A nav count as shown: capped at "99+". */
export function formatNavCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** "7 need you" / "1 needs you": the count as an accessible name reads it. */
export function needsYouPhrase(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/**
 * The Needs you count for the nav, from the same stores the dashboard reads.
 * Needs no pane titles or clock, so it re-renders only when an item can
 * come or go.
 */
export function useNeedsYouCount(): number {
  const projects = useProjectStore((s) => s.projects);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore(
    (s) => s.unseenRespondedAgentIds,
  );
  const snoozed = useActiveSnoozes();

  return useMemo(
    () =>
      visibleNeedsYouCount(
        { projects, agents, paneAgentStatus, unseenRespondedAgentIds },
        snoozed,
      ),
    [projects, agents, paneAgentStatus, unseenRespondedAgentIds, snoozed],
  );
}
