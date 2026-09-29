import type { NeedsYouCard, NeedsYouCardContext } from "../../../lib/home-dashboard-studio";
import type { NeedsYouTier } from "../../../lib/home-dashboard";

/** Card accent per Needs-you tier (ADR-194 §1: red / yellow / green / cyan). */
export const TIER_COLOR: Record<NeedsYouTier, string> = {
  input: "var(--red)",
  error: "var(--red)",
  blocked: "var(--yellow)",
  ready: "var(--green)",
  finished: "var(--cyan)",
};

/** The uppercase kind label in a card's header, per context. */
const KIND_LABEL: Record<NeedsYouCardContext["kind"], string> = {
  input: "Needs input",
  error: "Agent errored",
  checks: "Checks failing",
  conflicts: "Conflicts",
  "changes-requested": "Changes requested",
  threads: "Unresolved threads",
  finished: "Finished",
  ready: "Ready to merge",
};

export function needsYouKindLabel(card: NeedsYouCard): string {
  return KIND_LABEL[card.context.kind];
}

/**
 * What the Waiting on you tile says about the longest wait: "manor agent
 * errored", "#91 checks failing".
 */
export function waitingOnLabel(card: NeedsYouCard): string {
  if (card.kind === "pr") return `#${card.pr.number} ${card.reason}`;
  const what =
    card.tier === "input" ? "agent needs input" : card.tier === "error" ? "agent errored" : "agent finished";
  return `${card.project.name} ${what}`;
}

/** A card's title: the agent's name, or "#N PR title". */
export function needsYouTitle(card: NeedsYouCard): string {
  if (card.kind === "pr") return `#${card.pr.number} ${card.pr.title}`;
  return card.agent.name ?? card.workspace?.name ?? card.workspace?.path ?? "Agent";
}
