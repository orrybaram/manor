import type { NotificationRecord } from "../electron.d";
import { useNotificationStore } from "../store/notification-store";
import { useAgentStore } from "../store/agent-store";
import { navigateToAgent } from "./agent-navigation";
import { requestPaletteView } from "./palette-request";
import { openExternal } from "../lib/open-external";
import { BADGE_META } from "../lib/badges";
import { useStatsStore } from "../store/stats-store";

/**
 * Resolve a notification to wherever it points. The single destination for
 * both a clicked native banner and a clicked row in the notifications
 * popover (ADR-162 §4) — two implementations of this is exactly the drift
 * this consolidates.
 */
export async function navigateToNotification(
  record: NotificationRecord,
): Promise<void> {
  if (!record.read) {
    await useNotificationStore.getState().markRead(record.id);
  }

  const target = record.target;
  // Records written before badges pointed anywhere carry a null target.
  if (
    target?.type === "stats" ||
    (!target && record.kind === "badge-unlocked")
  ) {
    // A badge opens the Badges tab on its track; a record from before
    // targets named their badge opens it on Summary.
    const badgeId = target?.type === "stats" ? target.badgeId : undefined;
    const section = BADGE_META.find((b) => b.id === badgeId)?.section;
    useStatsStore.getState().focusTrack(section ?? "summary");
    requestPaletteView("stats");
    return;
  }
  if (!target) return;

  if (target.type === "url") {
    openExternal(target.url);
    return;
  }

  const agents = useAgentStore.getState().agents;
  let agent = agents.find((t) => t.id === target.agentId) ?? null;
  if (!agent) {
    agent = (await window.electronAPI?.agents.get(target.agentId)) ?? null;
  }
  // The agent may have been pruned out from under the record; nothing to do.
  if (agent) navigateToAgent(agent);
}
